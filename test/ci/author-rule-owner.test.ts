import { REPO_ROOT as __workspaceRoot } from "#test/helpers/repo-root.js";
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { gitRepo } from '#test/helpers/git-repo.js';
import { ENV_REGISTRY } from '#src/lib/config-schema.js';
import { MIN_RULE_SUITE_COUNT } from '#src/lib/ci-parity.js';
import { resolveTestSlotDir } from '#src/lib/test-slot.js';
// @ts-ignore executable fixture module.
type AuthorModule = typeof import('#scripts/preflight-author.mjs');
// @ts-ignore executable fixture module.
type ReporterModule = typeof import('#scripts/lib/author-rule-native-reporter.mjs');
// @ts-ignore executable fixture module.
type RunnerModule = typeof import('#scripts/list-rule-suites.mjs');
// @ts-ignore executable fixture module.
type OwnerModule = typeof import('#scripts/lib/author-rule-owner.mjs');
let authorMain: AuthorModule['main'], authorEnvironment: AuthorModule['authorEnvironment'];
let nativeReporter: ReporterModule['default'];
let ruleSuites: RunnerModule['ruleSuites'], runRuleSuites: RunnerModule['runRuleSuites'];
let AUTHOR_RULE_OWNER_ENV: OwnerModule['AUTHOR_RULE_OWNER_ENV'];
let createAuthorRuleOwner: OwnerModule['createAuthorRuleOwner'];
let qualifiedAffectedRules: OwnerModule['qualifiedAffectedRules'];
let admittedAffectedRules: OwnerModule['admittedAffectedRules'];
let beginOwnedRuleResults: OwnerModule['beginOwnedRuleResults'];
let certifyRuleNativeSummary: OwnerModule['certifyRuleNativeSummary'];
let dependencyGraphDigest: OwnerModule['dependencyGraphDigest'];
let ownedPreflightBudgetResult: OwnerModule['ownedPreflightBudgetResult'];
let readOwnedStaticBudgetResult: OwnerModule['readOwnedStaticBudgetResult'];
let executeOwnedStaticPhases: OwnerModule['executeOwnedStaticPhases'];
let ownedStaticPhaseCommands: OwnerModule['ownedStaticPhaseCommands'];
let ownerLoaded = false;
async function loadOwnerImplementation() {
  assert.ok(existsSync(join(ROOT, 'scripts/lib/author-rule-owner.mjs')),
    'this source tree must contain the native rule-owner implementation');
  if (ownerLoaded) return;
  // @ts-ignore executable fixture module.
  ({main: authorMain, authorEnvironment} = await import('#scripts/preflight-author.mjs'));
  // @ts-ignore executable fixture module.
  nativeReporter = (await import('#scripts/lib/author-rule-native-reporter.mjs')).default;
  // @ts-ignore executable fixture module.
  ({ruleSuites, runRuleSuites} = await import('#scripts/list-rule-suites.mjs'));
  // @ts-ignore executable fixture module.
  const loadedOwner = await import('#scripts/lib/author-rule-owner.mjs');
  ({AUTHOR_RULE_OWNER_ENV, createAuthorRuleOwner, qualifiedAffectedRules, admittedAffectedRules, beginOwnedRuleResults, certifyRuleNativeSummary, dependencyGraphDigest,
    ownedPreflightBudgetResult, readOwnedStaticBudgetResult, executeOwnedStaticPhases, ownedStaticPhaseCommands} = loadedOwner);
  ownerLoaded = true;
}

const ROOT = __workspaceRoot;
const MODULE = pathToFileURL(join(ROOT, 'scripts/lib/author-rule-owner.mjs')).href;
const rules = ['test/shared-census.test.ts', 'test/only-census.test.ts'];
const affected = ['test/shared-census.test.ts', 'test/affected.test.ts'];
function fixture(t: { after: (fn: () => void) => void }) {
  const repo = gitRepo({ kind: 'author-rule-owner', seedCommit: false });
  t.after(() => repo.cleanup());
  for (const dir of ['test/setup', 'coverage', 'node_modules/@esbuild']) mkdirSync(join(repo.dir, dir), { recursive: true });
  writeFileSync(join(repo.dir, '.gitignore'), 'coverage\nnode_modules\n');
  writeFileSync(join(repo.dir, 'package.json'), '{"type":"module"}\n');
  writeFileSync(join(repo.dir, 'test/setup/tmp-hygiene.ts'), 'export {};\n');
  // The real installed loader and native transformer, without another npm install.
  for (const entry of ['tsx', 'esbuild', '@esbuild']) cpSync(join(ROOT, 'node_modules', entry), join(repo.dir, 'node_modules', entry), { recursive: true });
  // The maintained author also checks real installed metadata and tool bytes.
  // These fixture packages are copied from the locked installation; no precheck is faked or disabled.
  for (const entry of ['typescript', '@commitlint/cli']) cpSync(join(ROOT, 'node_modules', entry), join(repo.dir, 'node_modules', entry), { recursive: true });
  mkdirSync(join(repo.dir, 'node_modules/.bin'));
  for (const [name, entry] of [['tsx', 'tsx'], ['tsc', 'typescript'], ['commitlint', '@commitlint/cli']] as const) {
    const pkg = JSON.parse(readFileSync(join(repo.dir, 'node_modules', entry, 'package.json'), 'utf8'));
    const bin = typeof pkg.bin === 'string' ? pkg.bin : pkg.bin[name];
    assert.equal(typeof bin, 'string');
    symlinkSync(join('..', entry, bin), join(repo.dir, 'node_modules/.bin', name));
  }
  const locked = JSON.parse(readFileSync(join(ROOT, 'package-lock.json'), 'utf8'));
  const packages = Object.fromEntries(Object.entries(locked.packages).filter(([path]) =>
    path.startsWith('node_modules/') && existsSync(join(repo.dir, path, 'package.json'))));
  writeFileSync(join(repo.dir, 'package-lock.json'), JSON.stringify({ lockfileVersion: 3, packages }));
  const leaf = (name: string) => `import{test}from'node:test';import{appendFileSync}from'node:fs';\n` +
    `test(${JSON.stringify(name)},()=>appendFileSync('coverage/calls',${JSON.stringify(name + '\n')}));\n`;
  for (const file of [...rules, affected[1]!]) writeFileSync(join(repo.dir, file), leaf(file));
  repo.git('add', '.'); repo.git('commit', '-qm', 'test: native rule inputs');
  const fixtureSlots = join(repo.dir, 'coverage/private-fixture-slots');
  mkdirSync(fixtureSlots, { mode: 0o700 });
  const environment: NodeJS.ProcessEnv = { ...process.env, NODE_TEST_CONTEXT: undefined,
    NODE_V8_COVERAGE: '', RMD_AUTHOR_CAPTURE_PARENT_PID: undefined,
    RMD_TEST_SLOT_PARENT: undefined, RMD_TEST_SLOT_DIR: fixtureSlots };
  assert.equal(resolveTestSlotDir(environment).dir, fixtureSlots,
    'every real author fixture needs private admission even without inherited markers');
  for (const key of ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_AUTH_TOKEN']) delete environment[key];
  const handle = createAuthorRuleOwner({ root: repo.dir, directory: join(repo.dir, 'coverage'),
    head: repo.git('rev-parse', 'HEAD'), rules, affected, environment, concurrency: 1 });
  const rulesProgram = `import{beginOwnedRuleResults}from${JSON.stringify(MODULE)};
      const root=${JSON.stringify(repo.dir)},rules=${JSON.stringify(rules)};
      const owner=beginOwnedRuleResults(root,rules);
      if(!owner){console.log('unqualified');process.exit(2)};
      let fail=0;for(const file of rules)fail|=owner.run(file);const complete=owner.finish();process.exit(fail||complete);`;
  const runRules = (env = handle.childEnvironment) => spawnSync(process.execPath,
    ['--import', 'tsx', '--input-type=module', '-e', rulesProgram],
    { cwd: repo.dir, env, encoding: 'utf8', timeout: 30_000, maxBuffer: 1024 * 1024 });
  return { repo, handle, runRules, rulesProgram, environment, leaf, owner: () => JSON.parse(readFileSync(handle.file, 'utf8')) };
}

test('real rule completions satisfy overlap once and retain non-rule affected execution', async (t) => {
  await loadOwnerImplementation();
  const f = fixture(t);
  assert.equal(f.handle.childEnvironment[AUTHOR_RULE_OWNER_ENV], f.handle.descriptor);
  const native = f.runRules(); assert.equal(native.status, 0, native.stderr);
  const selected = qualifiedAffectedRules(f.handle, f.repo.dir, f.handle.childEnvironment, affected);
  assert.deepEqual(selected.remaining, [affected[1]]);
  assert.deepEqual(selected.reused.map((row: { suite: string }) => row.suite), [rules[0]]);
  const tail = spawnSync(process.execPath, ['--test', '--test-reporter=tap', '--test-concurrency=1', '--import', 'tsx', affected[1]!],
    { cwd: f.repo.dir, env: f.handle.childEnvironment, encoding: 'utf8', timeout: 30_000 });
  assert.equal(tail.status, 0, tail.stderr); assert.match(tail.stdout, /^# tests 1$/m);
  assert.deepEqual(readFileSync(join(f.repo.dir, 'coverage/calls'), 'utf8').trim().split('\n'), [...rules, affected[1]]);
  assert.equal(qualifiedAffectedRules(f.handle, f.repo.dir, f.handle.childEnvironment, affected).reused.length, 1);
});

function withRealOwnerEnvironment<T>(f: ReturnType<typeof fixture>, handle: typeof f.handle, fn: () => T): T {
  const saved = { ...process.env };
  try {
    for (const key of Object.keys(process.env)) if (!(key in handle.childEnvironment) || handle.childEnvironment[key] === undefined) delete process.env[key];
    for (const key of Object.keys(process.env)) delete process.env[key];
    for (const [key, value] of Object.entries(handle.childEnvironment)) if (typeof value === 'string') process.env[key] = value;
    return fn();
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
  }
}

test('the default rule edge really shells out and records native counts in the source process', async (t) => {
  await loadOwnerImplementation();
  const f = fixture(t);
  withRealOwnerEnvironment(f, f.handle, () => {
    const owner = beginOwnedRuleResults(f.repo.dir, rules); assert.ok(owner);
    for (const file of rules) assert.equal(owner.run(file), 0);
    assert.equal(owner.finish(), 0);
    assert.equal(qualifiedAffectedRules(f.handle, f.repo.dir, f.handle.childEnvironment, affected).reused.length, 1);
  });
  assert.equal(f.owner().results.length, 2);
  assert.ok(f.owner().results.every((row: { complete: boolean }) => row.complete));
});

test('author rule descriptor registration names the actual environment reader', async (t) => {
  await loadOwnerImplementation();
  const registrations = ENV_REGISTRY.filter((entry) => entry.name === AUTHOR_RULE_OWNER_ENV);
  assert.equal(registrations.length, 1, 'the executable descriptor key must have one registration');
  const actualReader = relative(ROOT, fileURLToPath(MODULE));
  assert.deepEqual(registrations[0]!.readBy, [actualReader],
    'the registry must name the module that reads the descriptor, including no delegating caller');
  const f = fixture(t);
  withRealOwnerEnvironment(f, f.handle, () => {
    const owner = beginOwnedRuleResults(f.repo.dir, rules);
    assert.ok(owner, 'the registered module must read the real live process descriptor');
    for (const file of rules) assert.equal(owner.run(file), 0);
    assert.equal(owner.finish(), 0);
  });
  assert.equal(f.owner().phase, 'complete');
  assert.equal(f.owner().results.length, rules.length);
  assert.ok(f.owner().results.every((row: { complete: boolean; nativeCounts: { passed: number } }) =>
    row.complete && row.nativeCounts.passed > 0));
});

test('the real preflight parent preserves qualified rule context after the SDK import', async (t) => {
  await loadOwnerImplementation();
  const f = fixture(t);
  delete f.environment.NoDefaultCurrentDirectoryInExePath;
  for (let index = 0; index < 18; index++) writeFileSync(join(f.repo.dir, `test/sdk-${index}-census.test.ts`),
    "import{test}from'node:test';test('real parent native population',()=>{});\n");
  f.repo.git('add', '.'); f.repo.git('commit', '-qm', 'test: real parent rule population');
  const required = ruleSuites(f.repo.dir);
  const directory = join(f.repo.dir, 'coverage/sdk-parent'); mkdirSync(directory);
  const handle = createAuthorRuleOwner({ root: f.repo.dir, directory, head: f.repo.git('rev-parse', 'HEAD'),
    rules: required, affected, environment: authorEnvironment(f.environment), concurrency: 1 });
  const task = pathToFileURL(join(ROOT, 'src/run-task.ts')).href;
  const compiler = pathToFileURL(join(ROOT, 'src/lib/commit-message.ts')).href;
  const population = pathToFileURL(join(ROOT, 'scripts/list-rule-suites.mjs')).href;
  const leaf = `import{runRuleSuites}from${JSON.stringify(population)};process.exitCode=runRuleSuites(${JSON.stringify(f.repo.dir)});`;
  const parent = `await import(${JSON.stringify(task)});
    const {defaultPreflightSpawn}=await import(${JSON.stringify(compiler)});
    const result=defaultPreflightSpawn(process.execPath,['--import','tsx','--input-type=module','-e',${JSON.stringify(leaf)}],{cwd:${JSON.stringify(f.repo.dir)}});
    process.stdout.write(result.stdout);process.stderr.write(result.stderr);process.exitCode=result.status??1;`;
  const actual = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', parent],
    { cwd: f.repo.dir, env: handle.childEnvironment, encoding: 'utf8', timeout: 30_000, maxBuffer: 1024 * 1024 });
  assert.equal(actual.status, 0, actual.stderr);
  const owner = JSON.parse(readFileSync(handle.file, 'utf8'));
  assert.equal(owner.phase, 'complete', 'a real parent import must not silently disable same-author reuse');
  assert.equal(owner.results.length, required.length);
  assert.deepEqual(qualifiedAffectedRules(handle, f.repo.dir, handle.childEnvironment, affected).remaining, [affected[1]]);
});

function realAuthorAdmissionFixture(t: { after: (fn: () => void) => void }, boundary: 'rule' | 'affected',
  selection: 'mixed' | 'all-reused' | 'all-reused-red' = 'mixed') {
  const f = fixture(t);
  const witness = [...rules].sort()[0]; assert.ok(witness, 'the controlled selected rule population must be nonempty');
  for (const dir of ['scripts', 'src']) mkdirSync(join(f.repo.dir, dir));
  writeFileSync(join(f.repo.dir, '.nvmrc'), process.versions.node + '\n');
  writeFileSync(join(f.repo.dir, 'scripts/diff-class.mjs'), '// no fixture census readers\n');
  writeFileSync(join(f.repo.dir, 'scripts/census-precheck.mjs'), "console.log('fixture cheap census');\n");
  writeFileSync(join(f.repo.dir, 'src/leaf.ts'), 'export const value = 1;\n');
  const population = pathToFileURL(join(ROOT, 'scripts/list-rule-suites.mjs')).href;
  writeFileSync(join(f.repo.dir, 'src/run-task.ts'), `
    import assert from 'node:assert/strict';
    import { readFileSync, writeFileSync } from 'node:fs';
    import { runRuleSuites } from ${JSON.stringify(population)};
    const claim = JSON.parse(process.env.RMD_TEST_SLOT_PARENT ?? 'null');
    assert.ok(claim, 'the real static child still needs its admitted parent');
    assert.ok(readFileSync(claim.path, 'utf8'));
    process.exitCode = runRuleSuites(process.cwd());
    ${selection === 'all-reused-red' ? "if (process.exitCode === 0) writeFileSync('coverage/witness-red', 'fail the next real native witness');" : ''}
  `);
  const slotModule = pathToFileURL(join(ROOT, 'src/lib/test-slot.ts')).href;
  const privateAffectedAdmission = `
    const claim = JSON.parse(process.env.RMD_TEST_SLOT_PARENT ?? 'null');
    assert.ok(claim, 'affected descendants retain the quiescence marker');
    const before = readFileSync(claim.path, 'utf8');
    const resolved = resolveTestSlotDir();
    assert.equal(resolved.scope, 'test-process');
    assert.notEqual(resolved.dir, dirname(claim.path));
    const nested = acquireTestSlot('affected-native-private-admission', { maxConcurrency: 1, waitBoundMs: 0 });
    assert.equal(nested.outcome, 'acquired');
    assert.ok(nested.note.includes(resolved.dir));
    nested.refresh(); nested.release();
    assert.equal(readFileSync(claim.path, 'utf8'), before, 'private admission never changes the parent reservation');
  `;
  const nativeBody = (name: string, assertPrivate: boolean) => `
    import { test } from 'node:test';
    import assert from 'node:assert/strict';
    import { appendFileSync, existsSync, readFileSync } from 'node:fs';
    import { dirname } from 'node:path';
    import { acquireTestSlot, resolveTestSlotDir } from ${JSON.stringify(slotModule)};
    test(${JSON.stringify(name)}, () => {
      ${assertPrivate ? (boundary === 'affected' ? privateAffectedAdmission : "assert.equal(process.env.RMD_TEST_SLOT_PARENT, undefined, 'rule fixtures must not receive production slot authority'); assert.equal(process.env.RMD_TEST_SLOT_DIR, undefined, 'rule fixtures must not receive the production slot directory');") : ''}
      appendFileSync('coverage/calls', ${JSON.stringify(name + '\n')});
      ${selection === 'all-reused-red' && name === witness ? "assert.equal(existsSync('coverage/witness-red'), false, 'a failed real positive witness must fail the author');" : ''}
    });
  `;
  for (const name of rules) writeFileSync(join(f.repo.dir, name), nativeBody(name, boundary === 'rule'));
  for (let index = 0; index < 18; index++) writeFileSync(join(f.repo.dir, `test/admission-${index}-census.test.ts`),
    nativeBody(`admission-${index}`, boundary === 'rule'));
  writeFileSync(join(f.repo.dir, affected[1]!), nativeBody(affected[1]!, boundary === 'affected'));
  f.repo.git('add', '.'); f.repo.git('commit', '-qm', 'test: real admitted native population');
  f.repo.git('branch', '-M', 'main'); f.repo.git('remote', 'add', 'origin', f.repo.dir);
  f.repo.git('checkout', '-qb', 'run-unfiled-admission-fixture');
  writeFileSync(join(f.repo.dir, 'src/leaf.ts'), 'export const value = 2;\n');
  f.repo.git('add', '.'); f.repo.git('commit', '-qm', 'test: changed admitted leaf');
  // Invoke the real production boundary outside the enclosing node:test context. Native
  // children still receive Node's own test marker and must retain their private admission.
  const fixtureSlots = join(f.repo.dir, 'coverage/private-author-slots');
  mkdirSync(fixtureSlots, { mode: 0o700 });
  const fixtureEnvironment = { ...f.environment, NODE_OPTIONS: process.env.NODE_OPTIONS,
    RMD_TEST_SLOT_PARENT: undefined, RMD_TEST_SLOT_DIR: fixtureSlots };
  assert.equal(resolveTestSlotDir(fixtureEnvironment).dir, fixtureSlots,
    'a fixture outside Node test context must never wait on its enclosing author');
  const status = withRealOwnerEnvironment(f, { ...f.handle,
    childEnvironment: fixtureEnvironment }, () => authorMain([], { root: f.repo.dir,
      select: () => ({ fullRun: false, suites: selection === 'mixed' ? [...rules, affected[1]] : [...rules],
        reasons: ['actual physical native population'] }) }));
  const receipt = JSON.parse(readFileSync(join(f.repo.dir, 'coverage/preflight-author.json'), 'utf8'));
  assert.equal(status, selection === 'all-reused-red' ? 1 : 0,
    `${boundary} native fixture admission must be private: ${JSON.stringify(receipt.ruleExecution)}`);
  assert.equal(receipt.verdict, selection === 'all-reused-red' ? 'failed' : 'passed');
  assert.equal(receipt.testSlot.outcome, 'acquired');
  assert.ok(receipt.testSlot.note.includes(fixtureSlots), 'the fixture owns a private real slot');
  assert.equal(receipt.ruleExecution.state, 'qualified');
  assert.equal(receipt.ruleExecution.reusedFiles.length, selection === 'mixed' ? 2 : 1);
  assert.deepEqual(receipt.ruleExecution.physicalAffectedSuites, [selection === 'mixed' ? affected[1] : witness]);
  assert.equal(receipt.steps.at(-1).testSummary.tests, 1);
  assert.equal(receipt.steps.at(-1).testSummary.fail, selection === 'all-reused-red' ? 1 : 0);
  const calls = readFileSync(join(f.repo.dir, 'coverage/calls'), 'utf8').trim().split('\n');
  assert.equal(calls.length, 21);
  if (selection !== 'mixed') {
    assert.deepEqual(receipt.ruleExecution.reusedFiles.map((row: { suite: string }) => row.suite), rules.filter(file => file !== witness));
    assert.equal(calls.filter((name: string) => name === witness).length, 2);
    for (const file of rules.filter(file => file !== witness)) assert.equal(calls.filter((name: string) => name === file).length, 1);
    assert.ok(receipt.ruleExecution.reusedFiles[0].nativeCounts.passed > 0);
    assert.equal(receipt.hostedFullSuiteAndCoverage, 'required-pending');
    if (selection === 'all-reused-red') {
      const step = receipt.steps.at(-1);
      assert.equal(step.ok, false);
      const output = readFileSync(join(f.repo.dir, step.diagnostics.stdout), 'utf8')
        + readFileSync(join(f.repo.dir, step.diagnostics.stderr), 'utf8');
      assert.match(output, /a failed real positive witness must fail the author/);
      assert.equal(JSON.parse(readFileSync(join(f.repo.dir, receipt.ruleExecution.receipt), 'utf8')).phase, 'complete',
        'old successful rule evidence cannot turn a newly failed witness into author success');
    }
  }
}

test('real admitted author rule children keep native fixture admission private', async (t) => {
  await loadOwnerImplementation();
  realAuthorAdmissionFixture(t, 'rule');
});

test('real admitted author affected children keep native fixture admission private', async (t) => {
  await loadOwnerImplementation();
  realAuthorAdmissionFixture(t, 'affected');
});

test('an all-reused actual author repeats only one positive native witness', async (t) => {
  await loadOwnerImplementation();
  realAuthorAdmissionFixture(t, 'affected', 'all-reused');
});

test('a failed all-reused native witness keeps the actual author failed', async (t) => {
  await loadOwnerImplementation();
  realAuthorAdmissionFixture(t, 'affected', 'all-reused-red');
});

test('the real rule population default completes once and preserves a native failed child', async (t) => {
  await loadOwnerImplementation();
  for (const red of [false, true]) {
    const f = fixture(t);
    for (let index = 0; index < 18; index++) writeFileSync(join(f.repo.dir, `test/population-${index}-census.test.ts`),
      "import{test}from'node:test';test('native population',()=>{});\n");
    if (red) writeFileSync(join(f.repo.dir, rules[0]!), "import{test}from'node:test';test('native red',()=>{throw Error('real rule failure')});\n");
    f.repo.git('add', '.'); f.repo.git('commit', '-qm', 'test: distinct native population input');
    const directory = join(f.repo.dir, 'coverage/population'); mkdirSync(directory);
    const population = ruleSuites(f.repo.dir);
    assert.equal(population.length, 20);
    const handle = createAuthorRuleOwner({ root: f.repo.dir, directory, head: f.repo.git('rev-parse', 'HEAD'),
      rules: population, affected, environment: f.environment, concurrency: 1 });
    withRealOwnerEnvironment(f, handle, () => assert.equal(runRuleSuites(f.repo.dir), red ? 1 : 0));
    const owner = JSON.parse(readFileSync(handle.file, 'utf8'));
    assert.equal(owner.phase, red ? 'failed' : 'complete');
    assert.equal(owner.results.length, population.length);
    assert.equal(owner.results.filter((row: { complete: boolean }) => !row.complete).length, red ? 1 : 0);
  }
});

test('empty, skipped-only and signaled real children cannot create completed rule receipts', async (t) => {
  await loadOwnerImplementation();
  const bodies = ['export {};\n', "import{test}from'node:test';test.skip('skip',()=>{});\n",
    "process.kill(process.ppid,'SIGTERM');\n"];
  for (const [index, body] of bodies.entries()) {
    const f = fixture(t);
    writeFileSync(join(f.repo.dir, rules[0]!), body);
    f.repo.git('add', '.'); f.repo.git('commit', '-qm', 'test: distinct incomplete native rule');
    const directory = join(f.repo.dir, 'coverage', `incomplete-${index}`); mkdirSync(directory);
    const handle = createAuthorRuleOwner({ root: f.repo.dir, directory, head: f.repo.git('rev-parse', 'HEAD'),
      rules, affected, environment: f.environment, concurrency: 1 });
    withRealOwnerEnvironment(f, handle, () => {
      const owner = beginOwnedRuleResults(f.repo.dir, rules); assert.ok(owner);
      assert.equal(owner.run(rules[0]), 1);
      assert.equal(owner.run(rules[1]), 0);
      assert.equal(owner.finish(), 1);
    });
    const row = JSON.parse(readFileSync(handle.file, 'utf8'));
    assert.equal(row.phase, 'failed'); assert.equal(row.results[0].complete, false);
    assert.equal(typeof row.results[0].refusal, 'string');
  }
});

test('a resolved package mutation during actual rule work fails the completed owner', async (t) => {
  await loadOwnerImplementation();
  const f = fixture(t);
  withRealOwnerEnvironment(f, f.handle, () => {
    const owner = beginOwnedRuleResults(f.repo.dir, rules); assert.ok(owner);
    for (const file of rules) assert.equal(owner.run(file), 0);
    writeFileSync(join(f.repo.dir, 'node_modules/mutated.mjs'), 'export const changed=true;\n');
    assert.equal(owner.finish(), 1);
  });
  assert.equal(f.owner().phase, 'failed');
});

test('an owner cannot certify another head, a ghost, a duplicate or unbounded concurrency', async (t) => {
  await loadOwnerImplementation();
  const f = fixture(t);
  const options = { root: f.repo.dir, directory: join(f.repo.dir, 'coverage'), head: f.repo.git('rev-parse', 'HEAD'),
    rules, affected, environment: f.environment, concurrency: 1 };
  for (const change of [{ head: 'a'.repeat(40) }, { rules: ['test/ghost.test.ts'] }, { rules: [rules[0], rules[0]] }, { concurrency: 5 }])
    assert.throws(() => createAuthorRuleOwner({ ...options, ...change }));
  assert.equal(f.owner().phase, 'prepared');
});

test('foreign environment disables consolidation before any rule child executes', async (t) => {
  await loadOwnerImplementation();
  const f = fixture(t);
  const result = f.runRules({ ...f.handle.childEnvironment, RULE_FIXTURE_ENV: 'different' });
  assert.equal(result.status, 2, result.stderr);
  assert.equal(f.owner().phase, 'prepared');
  const selected = qualifiedAffectedRules(f.handle, f.repo.dir, f.handle.childEnvironment, affected);
  assert.deepEqual(selected.remaining, affected); assert.deepEqual(selected.reused, []);
});

test('source and resolved dependency mutation after completed rules refuse reuse', async (t) => {
  await loadOwnerImplementation();
  const f = fixture(t); assert.equal(f.runRules().status, 0);
  const file = join(f.repo.dir, 'test/affected.test.ts'), original = readFileSync(file);
  writeFileSync(file, Buffer.concat([original, Buffer.from('// changed\n')]));
  assert.throws(() => qualifiedAffectedRules(f.handle, f.repo.dir, f.handle.childEnvironment, affected), /dirty/);
  writeFileSync(file, original);
  writeFileSync(join(f.repo.dir, 'node_modules/changed.mjs'), 'export const changed=true;\n');
  assert.throws(() => qualifiedAffectedRules(f.handle, f.repo.dir, f.handle.childEnvironment, affected), /context changed/);
});

test('an actual rule failure is terminal and cannot be executed again by the owner', async (t) => {
  await loadOwnerImplementation();
  const f = fixture(t);
  writeFileSync(join(f.repo.dir, rules[0]!), "import{test}from'node:test';test('red',()=>{throw Error('real red')});\n");
  f.repo.git('add', '.'); f.repo.git('commit', '-qm', 'test: different failing input');
  // A distinct committed source gets a distinct owner; preserve the old prepared receipt.
  const dir = join(f.repo.dir, 'coverage/red'); mkdirSync(dir);
  const handle = createAuthorRuleOwner({ root: f.repo.dir, directory: dir, head: f.repo.git('rev-parse', 'HEAD'),
    rules, affected, environment: f.environment, concurrency: 1 });
  assert.equal(f.runRules(handle.childEnvironment).status, 1);
  const bytes = readFileSync(handle.file);
  assert.equal(JSON.parse(bytes.toString()).phase, 'failed');
  assert.notEqual(f.runRules(handle.childEnvironment).status, 0);
  assert.deepEqual(readFileSync(handle.file), bytes, 'terminal failure is unchanged');
  assert.throws(() => qualifiedAffectedRules(handle, f.repo.dir, handle.childEnvironment, affected), /failed or incomplete/);
});

test('native events need a positive physical file and equal cumulative counts', async () => {
  await loadOwnerImplementation();
  const counts = { tests: 2, passed: 2, failed: 0, cancelled: 0, skipped: 0, todo: 0, suites: 0, topLevel: 2 };
  const events = [{ type: 'test:summary', data: { file: '/real/file', success: true, counts } },
    { type: 'test:summary', data: { success: true, counts: { ...counts } } }];
  assert.deepEqual(certifyRuleNativeSummary('/real/file', events, 0), counts);
  for (const broken of [events.slice(1), [...events, events[0]],
    [{ ...events[0], data: { ...events[0]!.data, file: '/foreign' } }, events[1]],
    [events[0], { ...events[1], data: { ...events[1]!.data, counts: { ...counts, topLevel: 1 } } }],
    events.map((row) => ({ ...row, data: { ...row.data, counts: { ...counts, passed: 0, skipped: 2 } } }))])
    assert.throws(() => certifyRuleNativeSummary('/real/file', broken, 0));
  assert.throws(() => certifyRuleNativeSummary('/real/file', events, null), /failed/);
});

test('the native reporter retains actual summaries and excludes test output content', async (t) => {
  await loadOwnerImplementation();
  const f = fixture(t); assert.equal(f.runRules().status, 0);
  const bytes = readFileSync(f.owner().results[0].eventFile, 'utf8');
  const events = bytes.trim().split('\n').map(line => JSON.parse(line));
  const withOutput = [{ type: 'test:stdout', data: { message: 'content must not enter native receipts' } }, ...events];
  let retained = '';
  for await (const line of nativeReporter((async function* () { yield* withOutput; })())) retained += line;
  assert.equal(retained, bytes); assert.ok(!retained.includes('content must not enter'));
});

test('changed native output, a stale PID start and a foreign nonce cannot qualify', async (t) => {
  await loadOwnerImplementation();
  const f = fixture(t); assert.equal(f.runRules().status, 0);
  const owner = f.owner(), event = owner.results[0].eventFile;
  const bytes = readFileSync(event); writeFileSync(event, '[]\n');
  assert.throws(() => qualifiedAffectedRules(f.handle, f.repo.dir, f.handle.childEnvironment, affected), /receipt changed/);
  writeFileSync(event, bytes);
  const original = readFileSync(f.handle.file);
  for (const change of [{ start: 'reused PID' }, { nonce: 'foreign' }, { pid: 999999999 }]) {
    writeFileSync(f.handle.file, JSON.stringify({ ...owner, ...change }));
    assert.throws(() => qualifiedAffectedRules(f.handle, f.repo.dir, f.handle.childEnvironment, affected), /process/);
  }
  writeFileSync(f.handle.file, original);
});

test('dependency graph content changes even when package declarations do not', async (t) => {
  await loadOwnerImplementation();
  const f = fixture(t), before = dependencyGraphDigest(f.repo.dir);
  writeFileSync(join(f.repo.dir, 'node_modules/extra.mjs'), 'export const x=1;\n');
  assert.notEqual(dependencyGraphDigest(f.repo.dir).sha256, before.sha256);
  symlinkSync('./extra.mjs', join(f.repo.dir, 'node_modules/0-alias.mjs'));
  const linked = dependencyGraphDigest(f.repo.dir);
  writeFileSync(join(f.repo.dir, 'node_modules/extra.mjs'), 'export const x=2;\n');
  assert.notEqual(dependencyGraphDigest(f.repo.dir).sha256, linked.sha256);
  symlinkSync('/private/tmp', join(f.repo.dir, 'node_modules/outside'));
  assert.throws(() => dependencyGraphDigest(f.repo.dir), /leaves package graph/);
});

test('a foreign rule manifest and an already started owner refuse before extra execution', async (t) => {
  await loadOwnerImplementation();
  const f = fixture(t);
  const raw = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e',
    `import{beginOwnedRuleResults}from${JSON.stringify(MODULE)};beginOwnedRuleResults(${JSON.stringify(f.repo.dir)},[]);`],
    { cwd: f.repo.dir, env: f.handle.childEnvironment, encoding: 'utf8' });
  assert.notEqual(raw.status, 0); assert.match(raw.stderr, /manifest differs/);
  assert.equal(f.owner().phase, 'prepared'); assert.equal(f.runRules().status, 0);
  assert.notEqual(f.runRules().status, 0);
});

test('the actual author attributes shared native rules and runs only remaining affected files', async (t) => {
  await loadOwnerImplementation();
  const f = fixture(t);
  mkdirSync(join(f.repo.dir, 'src')); mkdirSync(join(f.repo.dir, 'scripts'));
  writeFileSync(join(f.repo.dir, '.nvmrc'), process.versions.node + '\n');
  writeFileSync(join(f.repo.dir, 'scripts/diff-class.mjs'), '// fixture has no external path-reader census\n');
  writeFileSync(join(f.repo.dir, 'scripts/census-precheck.mjs'), "console.log('cheap fixture census');\n");
  cpSync(join(ROOT, 'scripts/test-duration-reporter.mjs'), join(f.repo.dir, 'scripts/test-duration-reporter.mjs'));
  cpSync(join(ROOT, 'scripts/test-tier-manifest.json'), join(f.repo.dir, 'scripts/test-tier-manifest.json'));
  const runner = pathToFileURL(join(ROOT, 'scripts/list-rule-suites.mjs')).href;
  writeFileSync(join(f.repo.dir, 'src/run-task.ts'), `import{runRuleSuites}from${JSON.stringify(runner)};process.exitCode=runRuleSuites(${JSON.stringify(f.repo.dir)});\n`);
  for (let index = 0; index < 18; index++) {
    const file = `test/add-${index}-census.test.ts`;
    writeFileSync(join(f.repo.dir, file), f.leaf(file));
  }
  f.repo.git('add', '.'); f.repo.git('commit', '-qm', 'test: complete native author inputs');
  f.repo.git('branch', '-M', 'main'); f.repo.git('remote', 'add', 'origin', f.repo.dir);
  f.repo.git('checkout', '-b', 'run-unfiled-owner-fixture');
  for (const path of affected) writeFileSync(join(f.repo.dir, path), readFileSync(join(f.repo.dir, path), 'utf8') + '// current input\n');
  f.repo.git('add', '.'); f.repo.git('commit', '-qm', 'test: select shared rule and ordinary affected file');
  const status = withRealOwnerEnvironment(f, { ...f.handle,
    childEnvironment: { ...f.environment, NODE_OPTIONS: process.env.NODE_OPTIONS } }, () => authorMain([], { root: f.repo.dir }));
  const author = JSON.parse(readFileSync(join(f.repo.dir, 'coverage/preflight-author.json'), 'utf8'));
  assert.equal(status, 0, JSON.stringify(author.ruleExecution));
  assert.equal(author.verdict, 'passed'); assert.equal(author.ruleExecution.state, 'qualified');
  const requiredRules: string[] = ruleSuites(f.repo.dir);
  assert.equal(requiredRules.length, 20, 'the controlled default-selector population includes every real rule fixture');
  assert.deepEqual(author.suites, [...requiredRules, affected[1]].sort(), 'the default conservative selector retains the complete controlled population');
  assert.deepEqual(author.ruleExecution.reusedFiles.map((row: { suite: string }) => row.suite), requiredRules);
  assert.deepEqual(author.ruleExecution.physicalAffectedSuites, [affected[1]]);
  const calls = readFileSync(join(f.repo.dir, 'coverage/calls'), 'utf8').trim().split('\n');
  assert.equal(calls.length, requiredRules.length + 1, 'every selected physical fixture must emit its independent execution witness');
  for (const file of requiredRules) assert.equal(calls.filter((name: string) => name === file).length, 1);
  assert.equal(calls.filter((file: string) => file === affected[1]).length, 1);
  assert.equal(author.hostedFullSuiteAndCoverage, 'required-pending');
  assert.ok(author.ruleExecution.reusedFiles[0].nativeCounts.passed > 0);
  assert.equal(author.runtimeEvidence.state, 'partial', 'reused wrappers must not be relabeled complete timing');
  assert.equal(author.runtimeEvidence.physicalFiles, 1);
  assert.equal(author.runtimeEvidence.reusedPhysicalFiles, requiredRules.length);
  assert.equal(author.runtimeEvidence.selectedPhysicalFiles, requiredRules.length + 1);
  const { createHash } = await import('node:crypto');
  const actualPolicy = Object.fromEntries(['TZ', 'LANG', 'LC_ALL', 'NODE_ENV', 'NODE_OPTIONS', 'GOMAXPROCS', 'UV_THREADPOOL_SIZE']
    .map(key => [key, process.env[key] ?? null]));
  assert.equal(author.runtimeEvidence.bindings.environmentSha256,
    createHash('sha256').update(JSON.stringify(actualPolicy)).digest('hex'),
    'real partial timing must bind every actual resource cap rather than removing it');
  const durationPath = join(f.repo.dir, dirname(author.steps.at(-1).diagnostics.stdout), 'durations.json');
  const durations = JSON.parse(readFileSync(durationPath, 'utf8'));
  assert.deepEqual(Object.keys(durations.files), [affected[1]], 'raw observations name only the actually executed remaining file; qualification is separate');
});

test('an all-reused capacity subset retains one explicit native file without discovering the full tree', async (t) => {
  await loadOwnerImplementation();
  const f = fixture(t); assert.equal(f.runRules().status, 0);
  const qualified = qualifiedAffectedRules(f.handle, f.repo.dir, f.handle.childEnvironment, affected);
  const selected = admittedAffectedRules(qualified, [affected[0]]);
  const child = spawnSync(process.execPath,
    ['--test', '--test-reporter=tap', '--test-concurrency=1', '--import', 'tsx', ...selected.remaining],
    { cwd: f.repo.dir, env: f.handle.childEnvironment, encoding: 'utf8', timeout: 30_000 });
  assert.equal(child.status, 0, child.stderr); assert.match(child.stdout, /^# tests 1$/m);
  assert.deepEqual(selected.remaining, [affected[0]]); assert.deepEqual(selected.reused, []);
  assert.deepEqual(readFileSync(join(f.repo.dir, 'coverage/calls'), 'utf8').trim().split('\n'), [...rules, affected[0]]);
});

test('a capacity subset excludes unadmitted rule receipts and ordinary native files', async (t) => {
  await loadOwnerImplementation();
  const f = fixture(t); assert.equal(f.runRules().status, 0);
  const qualified = qualifiedAffectedRules(f.handle, f.repo.dir, f.handle.childEnvironment, affected);
  const selected = admittedAffectedRules(qualified, [affected[1]]);
  assert.deepEqual(selected.remaining, [affected[1]]); assert.deepEqual(selected.reused, []);
  const child = spawnSync(process.execPath,
    ['--test', '--test-reporter=tap', '--test-concurrency=1', '--import', 'tsx', ...selected.remaining],
    { cwd: f.repo.dir, env: f.handle.childEnvironment, encoding: 'utf8', timeout: 30_000 });
  assert.equal(child.status, 0, child.stderr); assert.match(child.stdout, /^# tests 1$/m);
  assert.deepEqual(readFileSync(join(f.repo.dir, 'coverage/calls'), 'utf8').trim().split('\n'), [...rules, affected[1]]);
  for (const files of [[], [affected[0], affected[0]], ['test/not-qualified.test.ts']])
    assert.throws(() => admittedAffectedRules(qualified, files), /nonempty unique subset/);
});

test('an all-reused multi-file capacity subset retains its other real native completions', async (t) => {
  await loadOwnerImplementation();
  const f = fixture(t);
  const population = [...rules, affected[1]!];
  const directory = join(f.repo.dir, 'coverage/all-reused-subset'); mkdirSync(directory);
  const handle = createAuthorRuleOwner({ root: f.repo.dir, directory, head: f.repo.git('rev-parse', 'HEAD'),
    rules: population, affected: population, environment: f.environment, concurrency: 1 });
  withRealOwnerEnvironment(f, handle, () => {
    const owner = beginOwnedRuleResults(f.repo.dir, population); assert.ok(owner);
    for (const file of population) assert.equal(owner.run(file), 0);
    assert.equal(owner.finish(), 0);
  });
  const before = readFileSync(handle.file);
  const qualified = qualifiedAffectedRules(handle, f.repo.dir, handle.childEnvironment, population);
  const admitted = population.slice(1);
  const selected = admittedAffectedRules(qualified, admitted);
  assert.deepEqual(selected.remaining, [admitted[0]]);
  assert.deepEqual(selected.reused.map((row: { suite: string }) => row.suite), [admitted[1]]);
  const child = spawnSync(process.execPath,
    ['--test', '--test-reporter=tap', '--test-concurrency=1', '--import', 'tsx', ...selected.remaining],
    { cwd: f.repo.dir, env: handle.childEnvironment, encoding: 'utf8', timeout: 30_000 });
  assert.equal(child.status, 0, child.stderr); assert.match(child.stdout, /^# tests 1$/m);
  assert.deepEqual(readFileSync(join(f.repo.dir, 'coverage/calls'), 'utf8').trim().split('\n'), [...population, admitted[0]]);
  assert.deepEqual(readFileSync(handle.file), before, 'reuse never rewrites its original native evidence');
  const after = qualifiedAffectedRules(handle, f.repo.dir, handle.childEnvironment, population);
  assert.deepEqual(after.reused.map((row: { suite: string }) => row.suite), population.slice(1));
});


test('same-author reuse accepts a verified immediate capture parent and refuses forged cancellation metadata', async t => {
  await loadOwnerImplementation();
  const f = fixture(t);
  for (const parent of ['not-a-pid', '0', String(process.ppid)]) {
    const child = f.runRules({ ...f.handle.childEnvironment, RMD_AUTHOR_CAPTURE_PARENT_PID: parent });
    assert.notEqual(child.status, 0, 'a foreign cancellation marker must not qualify a native result');
    assert.match(child.stderr, /unverified immediate capture parent/);
    assert.equal(f.owner().phase, 'prepared');
    assert.equal(f.owner().results.length, 0);
    assert.equal(existsSync(join(f.repo.dir, 'coverage/calls')), false);
  }
  // Refused probes leave the same owned fixture untouched; no package copies per probe.
  const run = f.runRules({ ...f.handle.childEnvironment, RMD_AUTHOR_CAPTURE_PARENT_PID: String(process.pid) });
  assert.equal(run.status, 0, run.stderr);
  assert.equal(qualifiedAffectedRules(f.handle, f.repo.dir, f.handle.childEnvironment, affected).reused.length, 1);
});


test('the real unowned rule fallback keeps production admission and cancellation metadata out of native fixtures', async t => {
  await loadOwnerImplementation();
  const f = fixture(t), file = 'test/fallback-census.test.ts';
  writeFileSync(join(f.repo.dir, file), `import{test}from'node:test';import assert from'node:assert/strict';import{appendFileSync}from'node:fs';
    test('fallback admission remains private',()=>{
      assert.equal(process.env.RMD_TEST_SLOT_PARENT,undefined);
      assert.equal(process.env.RMD_TEST_SLOT_DIR,undefined);
      assert.equal(process.env.RMD_AUTHOR_CAPTURE_PARENT_PID,undefined);
      appendFileSync('coverage/calls',${JSON.stringify(file + '\n')});
    });`);
  const population = [...rules, file];
  for (let index = population.length; index < MIN_RULE_SUITE_COUNT; index++) {
    const member = `test/fallback-${index}-census.test.ts`;
    population.push(member);
    writeFileSync(join(f.repo.dir, member), f.leaf(member));
  }
  f.repo.git('add', '.'); f.repo.git('commit', '-qm', 'test: real unowned native rule fallback');
  const status = withRealOwnerEnvironment(f, { ...f.handle, childEnvironment: {
    ...f.environment, [AUTHOR_RULE_OWNER_ENV]: undefined, NODE_OPTIONS: process.env.NODE_OPTIONS,
    RMD_TEST_SLOT_PARENT: 'synthetic-unusable-production-claim', RMD_TEST_SLOT_DIR: join(f.repo.dir, 'not-the-native-pool'),
    RMD_AUTHOR_CAPTURE_PARENT_PID: '0',
  } }, () => runRuleSuites(f.repo.dir));
  assert.equal(status, 0);
  assert.deepEqual(readFileSync(join(f.repo.dir, 'coverage/calls'), 'utf8').trim().split('\n').sort(), population.sort());
  assert.equal(f.owner().phase, 'prepared', 'ordinary fallback does not fabricate an owned completion');
});

test('a captured static default spawn preserves immediate cancellation ancestry and actual same-author rule completion', async t => {
  await loadOwnerImplementation();
  const f = fixture(t);
  // @ts-ignore executable production capture module.
  const { captureStepSync } = await import('#scripts/lib/author-step-capture.mjs');
  const child = `import assert from 'node:assert/strict';
    assert.equal(process.env.RMD_AUTHOR_CAPTURE_PARENT_PID,String(process.ppid));
    ${f.rulesProgram}`;
  const intermediate = `import {defaultPreflightSpawn} from ${JSON.stringify(pathToFileURL(join(ROOT, 'src/lib/commit-message.ts')).href)};
    const result=defaultPreflightSpawn(process.execPath,${JSON.stringify(['--import', 'tsx', '--input-type=module', '-e', child])},
      {cwd:process.cwd(),env:{RMD_AUTHOR_CAPTURE_PARENT_PID:'0'}});
    process.stdout.write(result.stdout);process.stderr.write(result.stderr);process.exit(result.status??1);`;
  const directory = join(f.repo.dir, 'coverage/captured-static'); mkdirSync(directory);
  const result = captureStepSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', intermediate], {
    cwd: f.repo.dir, env: f.handle.childEnvironment, trackParent: true, runtimeMs: 30_000, maxBytes: 1024 * 1024,
    stdoutPath: join(directory, 'stdout'), stderrPath: join(directory, 'stderr'), resultPath: join(directory, 'native.json'),
  });
  assert.equal(result.status, 0, result.stderr); assert.equal(result.signal, null); assert.equal(result.error, undefined);
  assert.equal(result.outputComplete, true);
  assert.equal(f.owner().phase, 'complete'); assert.equal(f.owner().results.length, 2);
  assert.ok(f.owner().results.every((row: { complete: boolean }) => row.complete));
  assert.deepEqual(readFileSync(join(f.repo.dir, 'coverage/calls'), 'utf8').trim().split('\n'), rules);
  assert.equal(qualifiedAffectedRules(f.handle, f.repo.dir, f.handle.childEnvironment, affected).reused.length, 1);
});

test('an ordinary default preflight spawn cannot invent cancellation ancestry from supplied or unverified metadata', async () => {
  await loadOwnerImplementation();
  const { defaultPreflightSpawn } = await import('#src/lib/commit-message.js');
  const saved = process.env.RMD_AUTHOR_CAPTURE_PARENT_PID;
  try {
    for (const parent of [undefined, '0', 'not-a-pid']) {
      if (parent === undefined) delete process.env.RMD_AUTHOR_CAPTURE_PARENT_PID;
      else process.env.RMD_AUTHOR_CAPTURE_PARENT_PID = parent;
      const expected = JSON.stringify([process.env.NODE_OPTIONS ?? null, process.env.GOMAXPROCS ?? null, process.env.UV_THREADPOOL_SIZE ?? null]);
      const result = defaultPreflightSpawn(process.execPath, ['--input-type=module', '-e', `import assert from 'node:assert/strict';
        assert.equal(process.env.RMD_AUTHOR_CAPTURE_PARENT_PID,undefined);
        assert.deepEqual([process.env.NODE_OPTIONS??null,process.env.GOMAXPROCS??null,process.env.UV_THREADPOOL_SIZE??null],${expected});
        console.log('ordinary-cancellation-input-refused');`], { env: { RMD_AUTHOR_CAPTURE_PARENT_PID: String(process.pid) } });
      assert.equal(result.status, 0, result.stderr); assert.equal(result.error, undefined); assert.equal(result.signal, undefined);
      assert.match(result.stdout, /ordinary-cancellation-input-refused/);
    }
    process.env.RMD_AUTHOR_CAPTURE_PARENT_PID = String(process.ppid);
    const verified = defaultPreflightSpawn(process.execPath, ['--input-type=module', '-e', `import assert from 'node:assert/strict';
      assert.equal(process.env.RMD_AUTHOR_CAPTURE_PARENT_PID,String(process.ppid));console.log('actual-parent-retained');`],
      { env: { RMD_AUTHOR_CAPTURE_PARENT_PID: '0' } });
    assert.equal(verified.status, 0, verified.stderr); assert.match(verified.stdout, /actual-parent-retained/);
  } finally {
    if (saved === undefined) delete process.env.RMD_AUTHOR_CAPTURE_PARENT_PID;
    else process.env.RMD_AUTHOR_CAPTURE_PARENT_PID = saved;
  }
});

test('the real fast gate preserves a declared heap bound and completes its actual native rule owner', async (t) => {
  await loadOwnerImplementation();
  const { runPreflightFast } = await import('#src/lib/ci-parity.js');
  const f = fixture(t);
  mkdirSync(join(f.repo.dir, 'scripts'));
  for (let index = 0; index < 18; index++) writeFileSync(join(f.repo.dir, `test/heap-${index}-census.test.ts`),
    "import {test} from 'node:test';test('real bounded native population',()=>{});\n");
  const population = pathToFileURL(join(ROOT, 'scripts/list-rule-suites.mjs')).href;
  writeFileSync(join(f.repo.dir, 'scripts/list-rule-suites.mjs'),
    `import {runRuleSuites} from ${JSON.stringify(population)};process.exitCode=runRuleSuites(process.cwd());\n`);
  f.repo.git('add', '.'); f.repo.git('commit', '-qm', 'test: actual fast gate bounded rule context');
  const required = ruleSuites(f.repo.dir);
  const directory = join(f.repo.dir, 'coverage/heap-fast-gate'); mkdirSync(directory);
  const handle = createAuthorRuleOwner({ root: f.repo.dir, directory,
    head: f.repo.git('rev-parse', 'HEAD'), rules: required, affected,
    environment: authorEnvironment({ ...f.environment, NODE_OPTIONS: '--max-old-space-size=1024' }), concurrency: 1 });
  const result = withRealOwnerEnvironment(f, handle, () => runPreflightFast(f.repo.dir, {
    steps: [{ job: 'rule-checks', script: 'rule-checks:population', runner: 'rule-checks', reason: 'real bounded owner integration' }],
  }));
  assert.equal(result.ok, true, JSON.stringify(result));
  const owner = JSON.parse(readFileSync(handle.file, 'utf8'));
  assert.equal(owner.phase, 'complete', 'a green fallback cannot qualify same-invocation rule reuse');
  assert.equal(owner.results.length, required.length);
  assert.ok(owner.results.every((row: {complete: boolean}) => row.complete));
  assert.deepEqual(qualifiedAffectedRules(handle, f.repo.dir, handle.childEnvironment, affected).remaining, [affected[1]]);
});


test('the real rule runner reports unknown owner completion without fabricating a failed suite', async t => {
  await loadOwnerImplementation();
  const f = fixture(t);
  for (let index = 0; index < 18; index++) writeFileSync(join(f.repo.dir, `test/unknown-${index}-census.test.ts`),
    "import{test}from'node:test';test('native population',()=>{});\n");
  f.repo.git('add', '.'); f.repo.git('commit', '-qm', 'test: tracked unknown completion rule population');
  const population = ruleSuites(f.repo.dir);
  assert.equal(population.length, 20);
  // Every actual native rule succeeds. Only the final context identity changes,
  // so the real runner must report unavailable completion, without inventing red suites.
  writeFileSync(join(f.repo.dir, population.at(-1)!),
    "import{test}from'node:test';import{writeFileSync}from'node:fs';" +
    "test('native successful dependency mutation',()=>writeFileSync('node_modules/changed-after-native-rule.mjs','export const changed=true;'));\n");
  f.repo.git('add', '.'); f.repo.git('commit', '-qm', 'test: actual incomplete owner completion input');
  const directory = join(f.repo.dir, 'coverage/unknown-completion'); mkdirSync(directory);
  const handle = createAuthorRuleOwner({ root: f.repo.dir, directory, head: f.repo.git('rev-parse', 'HEAD'),
    rules: population, affected, environment: f.environment, concurrency: 1 });
  const errors: string[] = [];
  t.mock.method(console, 'error', (...args: unknown[]) => { errors.push(args.map(String).join(' ')); });
  withRealOwnerEnvironment(f, handle, () => assert.equal(runRuleSuites(f.repo.dir), 1));
  const owner = JSON.parse(readFileSync(handle.file, 'utf8'));
  assert.equal(owner.phase, 'failed');
  assert.equal(owner.results.length, population.length);
  assert.ok(owner.results.every((result: {complete: boolean; exit: number; nativeCounts: {passed: number}}) =>
    result.complete && result.exit === 0 && result.nativeCounts.passed > 0), 'every real native rule passed');
  assert.match(errors.join('\n'), /^rule-checks: owner completion unavailable$/m);
  assert.doesNotMatch(errors.join('\n'), /rule-checks: failed suites:/);
});

function budgetHandle(f: ReturnType<typeof fixture>, population = rules, budgetMs = 1000) {
  const directory = join(f.repo.dir, 'coverage/bounded-rules'); mkdirSync(directory, { recursive: true });
  const head = f.repo.git('rev-parse', 'HEAD');
  return createAuthorRuleOwner({ root: f.repo.dir, directory, head, rules: population, affected,
    environment: f.environment, concurrency: 1, budgetMs,
    parentCensus: { root: f.repo.dir, head, base: head, state: 'over-capacity' } });
}

function slowRule(f: ReturnType<typeof fixture>, contents = '') {
  writeFileSync(join(f.repo.dir, rules[0]!),
    `import{test}from'node:test';import assert from'node:assert/strict';` +
    `test('started real rule',()=>{Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,1100);${contents}});\n`);
  f.repo.git('add', '.'); f.repo.git('commit', '-qm', 'test: real bounded rule input');
}

function runBudgetRules(f: ReturnType<typeof fixture>, handle: ReturnType<typeof budgetHandle>) {
  const program = `import{beginOwnedRuleResults}from${JSON.stringify(MODULE)};
    const o=beginOwnedRuleResults(process.cwd(),${JSON.stringify(rules)});if(!o)process.exit(2);
    let failed=false;for(const file of ${JSON.stringify(rules)}){const s=o.run(file);if(s===3)break;if(s!==0)failed=true;}
    const status=o.finish();process.exit(failed?1:status);`;
  return spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', program],
    { cwd: f.repo.dir, env: handle.childEnvironment, encoding: 'utf8', timeout: 20_000, maxBuffer: 1024 * 1024 });
}

test('bounded rules defer only unstarted physical files and retain genuine positive native counts', async t => {
  await loadOwnerImplementation();
  const f = fixture(t); slowRule(f);
  const handle = budgetHandle(f), native = runBudgetRules(f, handle);
  assert.equal(native.status, 3, native.stderr); assert.equal(native.signal, null); assert.equal(native.error, undefined);
  const owner = JSON.parse(readFileSync(handle.file, 'utf8'));
  assert.equal(owner.phase, 'over-capacity'); assert.deepEqual(owner.budget.completed, [rules[0]]);
  assert.deepEqual(owner.budget.deferred, [rules[1]]); assert.deepEqual(owner.budget.failed, []); assert.deepEqual(owner.budget.unknown, []);
  assert.equal(owner.results.length, 1); assert.equal(owner.results[0].nativeCounts.passed, 1);
  assert.deepEqual(qualifiedAffectedRules(handle, f.repo.dir, handle.childEnvironment, affected).reused.map((row: {suite: string}) => row.suite), [rules[0]]);
  withRealOwnerEnvironment(f, handle, () => {
    assert.equal(ownedPreflightBudgetResult(f.repo.dir, 'rules').state, 'over-capacity');
    assert.equal(ownedPreflightBudgetResult(f.repo.dir, 'census').state, 'over-capacity');
    assert.throws(() => ownedPreflightBudgetResult(f.repo.dir, 'foreign'), /unknown/);
  });
  const summary = { headSha: owner.head, ok: false, disposition: 'over-capacity', failed: 0,
    deferred: ['rule-checks', 'census-precheck'], steps: [{ name: 'rule-checks', ok: false },
      { name: 'independent', ok: true }, { name: 'census-precheck', ok: false }] };
  const exit = { status: 3, outputComplete: true };
  assert.equal(readOwnedStaticBudgetResult(handle, f.repo.dir, handle.childEnvironment, exit, summary).state, 'over-capacity');
  for (const bad of [{ ...exit, status: 1 }, { ...exit, signal: 'SIGTERM' }, { ...exit, error: { code: 'ETIMEDOUT' } },
    { ...exit, outputComplete: false }]) assert.equal(readOwnedStaticBudgetResult(handle, f.repo.dir, handle.childEnvironment, bad, summary), undefined);
  for (const bad of [{ ...summary, headSha: '0'.repeat(40) }, { ...summary, ok: true }, { ...summary, failed: 1 },
    { ...summary, deferred: ['rule-checks'] }, { ...summary, steps: [...summary.steps, { name: 'actual-failure', ok: false }] }])
    assert.equal(readOwnedStaticBudgetResult(handle, f.repo.dir, handle.childEnvironment, exit, bad), undefined);
  owner.budget.deferred = []; writeFileSync(handle.file, JSON.stringify(owner));
  assert.throws(() => qualifiedAffectedRules(handle, f.repo.dir, handle.childEnvironment, affected), /unqualified partial/);
});

test('a real failed rule remains failed beside deferred work and preserves native error diagnostics', async t => {
  await loadOwnerImplementation();
  const f = fixture(t); slowRule(f, `assert.equal('observed','required','actual rule assertion');`);
  const handle = budgetHandle(f), native = runBudgetRules(f, handle);
  assert.equal(native.status, 1, native.stderr);
  const owner = JSON.parse(readFileSync(handle.file, 'utf8'));
  assert.equal(owner.phase, 'failed'); assert.deepEqual(owner.budget.failed, [rules[0]]);
  assert.deepEqual(owner.budget.deferred, [rules[1]]); assert.equal(owner.results[0].complete, false);
  const events = readFileSync(owner.results[0].eventFile, 'utf8');
  assert.match(events, /test:fail/); assert.match(events, /actual rule assertion/);
  assert.throws(() => qualifiedAffectedRules(handle, f.repo.dir, handle.childEnvironment, affected), /failed or incomplete/);
  withRealOwnerEnvironment(f, handle, () => assert.throws(() => ownedPreflightBudgetResult(f.repo.dir, 'rules'), /failed, changed or incomplete/));
});

test('a started rule with no native completion remains unknown instead of budget-only', async t => {
  await loadOwnerImplementation();
  const f = fixture(t); slowRule(f, 'process.exit(0);');
  const handle = budgetHandle(f), native = runBudgetRules(f, handle);
  assert.equal(native.status, 1, native.stderr);
  const owner = JSON.parse(readFileSync(handle.file, 'utf8'));
  assert.equal(owner.phase, 'failed'); assert.deepEqual(owner.budget.unknown, [rules[0]]);
  assert.equal(owner.results[0].complete, false);
  assert.throws(() => qualifiedAffectedRules(handle, f.repo.dir, handle.childEnvironment, affected), /failed or incomplete/);
});

test('the real fast gate continues independent checks after partial rules and retains its partial parent census', async t => {
  await loadOwnerImplementation();
  const { runPreflightFast } = await import('#src/lib/ci-parity.js');
  const f = fixture(t); mkdirSync(join(f.repo.dir, 'scripts'));
  for (let index = 0; index < 18; index++) writeFileSync(join(f.repo.dir, `test/00-${index}-census.test.ts`), f.leaf(`native-${index}`));
  const population = pathToFileURL(join(ROOT, 'scripts/list-rule-suites.mjs')).href;
  writeFileSync(join(f.repo.dir, 'scripts/list-rule-suites.mjs'),
    `import{runRuleSuites}from${JSON.stringify(population)};process.exitCode=runRuleSuites(process.cwd());\n`);
  writeFileSync(join(f.repo.dir, 'scripts/census-precheck.mjs'), "throw Error('parent census must not run twice');\n");
  writeFileSync(join(f.repo.dir, 'scripts/independent.mjs'), "import{writeFileSync}from'node:fs';writeFileSync('coverage/independent','actual independent native check');\n");
  writeFileSync(join(f.repo.dir, 'package.json'), JSON.stringify({type: 'module', scripts: {independent: 'node scripts/independent.mjs'}}));
  writeFileSync(join(f.repo.dir, 'test/00-0-census.test.ts'),
    "import{test}from'node:test';test('real first rule',()=>Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,1100));\n");
  f.repo.git('add', '.'); f.repo.git('commit', '-qm', 'test: actual partial fast gate');
  const required = ruleSuites(f.repo.dir); assert.equal(required.length, 20);
  const handle = budgetHandle(f, required);
  // The separated native rule phase has already finished. The maintained fast
  // runner must consume these original receipts without launching rules again.
  withRealOwnerEnvironment(f, handle, () => {
    const producer = beginOwnedRuleResults(f.repo.dir, required); assert.ok(producer);
    assert.equal(producer.run(required[0]), 0); assert.equal(producer.run(required[1]), 3);
    assert.equal(producer.finish(), 3);
  });
  const result = withRealOwnerEnvironment(f, handle, () => runPreflightFast(f.repo.dir, { steps: [
    { job: 'rule-checks', script: 'rules', runner: 'rule-checks', reason: 'native partial producer' },
    { job: 'independent', script: 'independent', reason: 'real independent native check' },
    { job: 'census-precheck', script: 'census-precheck', runner: 'census-precheck', reason: 'retain real parent disposition' },
  ] }));
  assert.equal(result.ok, false, JSON.stringify(result));
  assert.deepEqual(result.deferred, ['rule-checks', 'census-precheck'], JSON.stringify(result));
  assert.equal(result.steps[1]!.ok, true, result.steps[1]!.detail);
  assert.equal(readFileSync(join(f.repo.dir, 'coverage/independent'), 'utf8'), 'actual independent native check');
  assert.ok(result.steps.filter(step => !step.ok).every(step => step.detail.includes('OVER-CAPACITY')));
  const owner = JSON.parse(readFileSync(handle.file, 'utf8'));
  assert.deepEqual(owner.budget.deferred, required.slice(1)); assert.equal(owner.results.length, 1);
  writeFileSync(join(f.repo.dir, 'node_modules/changed-after-budget.mjs'), 'export const changed=true;');
  withRealOwnerEnvironment(f, handle, () => assert.throws(() => ownedPreflightBudgetResult(f.repo.dir, 'census'), /changed/));
});

test('bounded rule policy refuses oversized time or parallelism without changing full-owner defaults', async t => {
  await loadOwnerImplementation();
  const f = fixture(t);
  for (const budgetMs of [0, -1, 60001, NaN]) assert.throws(() => budgetHandle(f, rules, budgetMs), /allowance/);
  assert.throws(() => createAuthorRuleOwner({ root: f.repo.dir, directory: join(f.repo.dir, 'coverage'),
    head: f.owner().head, rules, affected, environment: f.environment, concurrency: 2, budgetMs: 1000 }), /allowance/);
  const owner = f.owner(); assert.equal(owner.policy, undefined); assert.equal(f.runRules().status, 0);
});

test('an actual timeout of a started bounded rule remains incomplete and cannot become partial', async t => {
  await loadOwnerImplementation();
  // @ts-ignore executable production capture module.
  const { captureStepSync } = await import('#scripts/lib/author-step-capture.mjs');
  const f = fixture(t);
  writeFileSync(join(f.repo.dir, rules[0]!), "import{test}from'node:test';import{writeFileSync}from'node:fs';" +
    "test('started real timeout',()=>{writeFileSync('coverage/started-timeout','native');Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,10000);});\n");
  f.repo.git('add', '.'); f.repo.git('commit', '-qm', 'test: real native timeout input');
  const handle = budgetHandle(f), directory = join(f.repo.dir, 'coverage/timeout-capture'); mkdirSync(directory);
  const program = `import{beginOwnedRuleResults,observeOwnedStaticStep}from${JSON.stringify(MODULE)};const o=beginOwnedRuleResults(process.cwd(),${JSON.stringify(rules)});if(!o)process.exit(2);observeOwnedStaticStep(process.cwd(),'actual-native-leaf','started');o.run(${JSON.stringify(rules[0])});process.exit(o.finish());`;
  const native = captureStepSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', program], {
    cwd: f.repo.dir, env: handle.childEnvironment, runtimeMs: 2000, maxBytes: 1024 * 1024,
    stdoutPath: join(directory, 'stdout'), stderrPath: join(directory, 'stderr'), resultPath: join(directory, 'native.json'),
  });
  assert.equal(readFileSync(join(f.repo.dir, 'coverage/started-timeout'), 'utf8'), 'native');
  assert.ok(native.signal || native.error, JSON.stringify(native));
  const boundary = readFileSync(join(directory, 'stderr'), 'utf8').split('\n')
    .filter(line => line.startsWith('{')).map(line => JSON.parse(line)).find(row => row.step === 'bounded-static-step');
  assert.equal(boundary?.name, 'actual-native-leaf'); assert.equal(boundary?.event, 'started');
  assert.equal(boundary?.head, f.repo.git('rev-parse', 'HEAD')); assert.equal(boundary?.ownerPid, process.pid);
  assert.equal(JSON.parse(readFileSync(handle.file, 'utf8')).phase, 'running');
  assert.equal(readOwnedStaticBudgetResult(handle, f.repo.dir, handle.childEnvironment, native, {}), undefined);
  assert.throws(() => qualifiedAffectedRules(handle, f.repo.dir, handle.childEnvironment, affected), /failed or incomplete/);
});

type StaticPhaseSpec = {name: string; args: string[]; phase?: string; summary?: string};

test('separate bounded static tiers retain every maintained obligation and stop on each native failure', async t => {
  await loadOwnerImplementation();
  const f = fixture(t); slowRule(f); const handle = budgetHandle(f);
  assert.equal(runBudgetRules(f, handle).status, 3);
  const names = ['static-default', 'static-rules', 'static-fast', 'static-ci-checks', 'static-scoped-coverage'];
  const specs = ownedStaticPhaseCommands(f.repo.dir, f.owner().head, dirname(handle.file));
  assert.deepEqual(specs.map((row: StaticPhaseSpec) => row.name), names);
  assert.ok(specs[0].args.includes('--no-fast')); assert.ok(specs[1].args.some((arg: string) => arg.endsWith('scripts/list-rule-suites.mjs')));
  const head = JSON.parse(readFileSync(handle.file, 'utf8')).head;
  const writeSummary = (phase: StaticPhaseSpec) => {
    if (!phase.summary) return;
    const partial = phase.phase === 'fast';
    writeFileSync(phase.summary, JSON.stringify({headSha: head, phase: phase.phase, ok: !partial, failed: 0,
      steps: partial ? [{name: 'rule-checks', ok: false}, {name: 'census-precheck', ok: false}] : [{name: phase.name, ok: true}],
      ...(partial ? {disposition: 'over-capacity', deferred: ['rule-checks', 'census-precheck']} : {})}));
  };
  const success = (phase: StaticPhaseSpec) => {writeSummary(phase); return {status: ['static-rules', 'static-fast'].includes(phase.name) ? 3 : 0, outputComplete: true};};
  const seen: string[] = [], reported: {name: string; ok: boolean}[] = [];
  const result = executeOwnedStaticPhases({root: f.repo.dir, base: head, owner: handle,
    run: (phase: StaticPhaseSpec) => {seen.push(phase.name);return success(phase);},
    report: (phase: StaticPhaseSpec, _native: unknown, ok: boolean) => reported.push({name: phase.name, ok})});
  assert.equal(result.ok, true); assert.equal(result.partial, true); assert.deepEqual(seen, names);
  assert.equal(reported.length, 5); assert.ok(reported.every(row => row.ok));
  for (const [index, name] of names.entries()) for (const bad of [
    {status: 1, outputComplete: true}, {status: null, signal: 'SIGTERM', outputComplete: false},
    {status: 3, outputComplete: true, error: {code: 'ETIMEDOUT'}}, {status: 0, outputComplete: false}]) {
    const calls: string[] = [];
    const failed = executeOwnedStaticPhases({root: f.repo.dir, base: head, owner: handle,
      run: (phase: StaticPhaseSpec) => {calls.push(phase.name);return phase.name === name ? bad : success(phase);}, report: () => {}});
    assert.equal(failed.ok, false, JSON.stringify({name,bad})); assert.deepEqual(calls, names.slice(0,index+1));
  }
  const directory = join(f.repo.dir, 'coverage/prepared-but-unmeasured'); mkdirSync(directory);
  const unmeasured = createAuthorRuleOwner({root:f.repo.dir, directory, head, rules, affected,
    environment:f.environment, concurrency:1, budgetMs:1000,
    parentCensus:{root:f.repo.dir, head, base:head, state:'over-capacity'}});
  const calls: string[] = [];
  const missing = executeOwnedStaticPhases({root:f.repo.dir, base:head, owner:unmeasured,
    run:(phase: StaticPhaseSpec)=>{calls.push(phase.name);writeSummary(phase);return {status:0,outputComplete:true};}, report:()=>{}});
  assert.equal(missing.ok, false); assert.deepEqual(calls, names.slice(0,2));
  assert.match(missing.phases[1].refusal, /no qualified completion/);
});

test('the bounded static phase entry runs the real CI-check default and preserves a throwing leaf', async t => {
  await loadOwnerImplementation();
  assert.ok(existsSync(join(ROOT, 'scripts/author-static-phase.mjs')), 'the real phase entry must exist');
  // @ts-ignore executable phase runner.
  const {main} = await import('#scripts/author-static-phase.mjs');
  const f = fixture(t), handle = budgetHandle(f), target = join(dirname(handle.file), 'real-ci.summary.json');
  const code = withRealOwnerEnvironment(f, handle, () => main(['--phase','ci-checks','--summary-file',target], {root:f.repo.dir}));
  assert.equal(code, 1, 'missing physical native CI fixtures must remain a real failed default');
  const summary = JSON.parse(readFileSync(target, 'utf8'));
  assert.equal(summary.ok, false); assert.ok(summary.failed > 0); assert.equal(summary.phase, 'ci-checks');
  assert.ok(summary.steps.some((step: {detail: string}) => /FAIL/.test(step.detail)));
  const thrown = join(dirname(handle.file), 'throw.summary.json');
  const refusal = withRealOwnerEnvironment(f, handle, () => main(['--phase','ci-checks','--summary-file',thrown],
    {root:f.repo.dir, ciChecks:()=>{throw Error('actual bounded leaf invocation refused');}}));
  assert.equal(refusal, 1); assert.match(readFileSync(thrown, 'utf8'), /actual bounded leaf invocation refused/);
  withRealOwnerEnvironment(f, handle, () => {
    assert.throws(() => main(['--phase','unknown','--summary-file',thrown], {root:f.repo.dir}), /unknown/);
    assert.throws(() => main(['--phase','fast','--summary-file',join(f.repo.dir,'outside.json')], {root:f.repo.dir}), /owner directory/);
  });
});

test('a complete same-owner rule phase is reused without running a second native child', async t => {
  await loadOwnerImplementation();
  const {runPreflightFast} = await import('#src/lib/ci-parity.js');
  const f = fixture(t), handle = budgetHandle(f, rules, 60000);
  assert.equal(runBudgetRules(f, handle).status, 0);
  const before = readFileSync(join(f.repo.dir, 'coverage/calls'), 'utf8');
  const result = withRealOwnerEnvironment(f, handle, () => runPreflightFast(f.repo.dir, {steps: [
    {job:'rule-checks', script:'rules', runner:'rule-checks', reason:'actual completed same-owner phase'},
  ]}));
  assert.equal(result.ok, true, JSON.stringify(result)); assert.equal(result.deferred, undefined);
  assert.equal(readFileSync(join(f.repo.dir, 'coverage/calls'), 'utf8'), before);
  assert.equal(JSON.parse(readFileSync(handle.file, 'utf8')).results.length, 2);
});
