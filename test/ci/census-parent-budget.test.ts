import assert from 'node:assert/strict';
import {test, type TestContext} from 'node:test';
import {existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {gitRepo} from '#test/helpers/git-repo.js';
import {makeRuntimeFixture} from '#test/helpers/native-runtime-fixture.js';
import {REPO_ROOT} from '#test/helpers/repo-root.js';

type Budget = {outputLimitBytes: number; admit: (label: string, bound: number, files?: string[]) => void;
  ensureFits: (label: string, bound: number, files?: string[]) => unknown;
  complete: (label: string, observation: Record<string, unknown>) => void;
  owns: (error: unknown) => boolean; receipt: (identity: Record<string, unknown>) => Record<string, unknown>};
type BudgetExports = {
  censusParentBudget: (budget?: string | number, now?: () => number, options?: {captureBytes: number}) => Budget | undefined;
  readCensusParentBudgetResult: (result: Record<string, unknown>, identity: Record<string, unknown>) => Record<string, unknown> | undefined;
  CENSUS_PARENT_BUDGET_PREFIX: string;
};
type CensusInput = {root: string; files: string[]; parentBudget?: Budget; captureRoot?: string};
type CensusModule = {
  main: (argv: string[], ports?: {measure?: Function; admitted?: Function; runSuites?: Function; now?: () => number}) => number;
  evaluateAdmittedCensusSuites: (input: Record<string, unknown>) => {violations: string[]; unmeasured: string | null};
  runCensusSuitesViaChild: (input: CensusInput & {run?: Function}) => string[];
};
type AuthorModule = {main: (argv: string[], ports: {root: string; select: Function; admitHost: Function}) => number};
const budgetModule = '#scripts/lib/census-parent-budget.mjs';
const censusModule = '#scripts/census-precheck.mjs';
const authorModule = '#scripts/preflight-author.mjs';
let censusParentBudget: BudgetExports['censusParentBudget'];
let readCensusParentBudgetResult: BudgetExports['readCensusParentBudgetResult'];
let prefix: string;
let census: CensusModule;
let authorMain: AuthorModule['main'];
async function loadBudget() {
  assert.ok(existsSync(join(REPO_ROOT, 'scripts/lib/census-parent-budget.mjs')),
    'this named test requires the actual parent-budget implementation');
  ({censusParentBudget, readCensusParentBudgetResult, CENSUS_PARENT_BUDGET_PREFIX: prefix} = await import(budgetModule) as BudgetExports);
  census = await import(censusModule) as CensusModule;
  ({main: authorMain} = await import(authorModule) as AuthorModule);
}

function capture(t: TestContext, run: () => number) {
  const errors: string[] = [];
  const error = t.mock.method(console, 'error', (...args: unknown[]) => {errors.push(args.join(' '));});
  const log = t.mock.method(console, 'log', () => {});
  try { return {status: run(), stderr: errors.join('\n'), outputComplete: true}; }
  finally {error.mock.restore(); log.mock.restore();}
}
function fixture(t: TestContext, instrument = false, nativeBody?: string) {
  const f = gitRepo({kind: 'census-parent-budget', scope: t});
  mkdirSync(join(f.dir, 'lib')); mkdirSync(join(f.dir, 'test'));
  writeFileSync(join(f.dir, 'lib/a.ts'), 'export const a=1;\n');
  writeFileSync(join(f.dir, 'test/a.test.ts'), nativeBody ?? 'import{test}from"node:test";test("native census case",()=>{});\n');
  f.git('add', '.'); f.git('commit', '-m', 'test: budget census base'); f.git('switch', '-c', 'work');
  writeFileSync(join(f.dir, 'lib/a.ts'), 'export const a=2;\n');
  if (instrument) {mkdirSync(join(f.dir, 'scripts')); writeFileSync(join(f.dir, 'scripts/leaf.mjs'), 'export const leaf=1;\n');}
  f.git('add', '.'); f.git('commit', '-m', 'test: budget census head');
  return f;
}
function partial() {
  let at = 0; const budget = censusParentBudget(110000, () => at)!;
  at = 105000;
  assert.throws(() => budget.admit('reader', 60000, ['test/a.test.ts']), error => budget.owns(error));
  const identity = {root: '/owned', head: 'a'.repeat(40), requestedBase: 'b'.repeat(40), budgetMs: 110000};
  return {identity, row: budget.receipt(identity)};
}

test('parent census budget is opt in and refuses invalid declarations and clocks', async () => {
  await loadBudget();
  assert.equal(censusParentBudget(undefined, () => {throw Error('default must not read budget clock');}), undefined);
  for (const value of [0, -1, 110001, 1.1, 'no', Infinity]) assert.throws(() => censusParentBudget(value));
  assert.throws(() => censusParentBudget(110000, () => NaN), /clock/);
  let at = 10; const budget = censusParentBudget(110000, () => at)!; at = 9;
  assert.throws(() => budget.admit('reader', 60000), /clock/);
});

test('parent census admits only a whole existing child bound plus shutdown reserve', async () => {
  await loadBudget();
  let at = 0; const budget = censusParentBudget(62000, () => at)!;
  budget.admit('fits', 60000); budget.complete('fits', {kind: 'observation'});
  at = 1; assert.throws(() => budget.admit('unstarted', 60000), error => budget.owns(error));
  assert.equal(budget.owns(new Error('parent census budget deferred unstarted before starting its child')), false);
  const row = budget.receipt({});
  assert.equal((row.admitted as unknown[]).length, 1); assert.equal((row.deferred as unknown[]).length, 1);
});

test('parent census bounds operation count and allocates nested output inside declared scratch', async () => {
  await loadBudget();
  const budget = censusParentBudget(110000, () => 0, {captureBytes: 64 * 1024 ** 2})!;
  assert.equal(budget.outputLimitBytes, 2 * 1024 ** 2);
  for (let i = 0; i < 32; i++) budget.admit(`operation-${i}`, 60000);
  assert.throws(() => budget.admit('unstarted-33', 60000), error => budget.owns(error));
  const row = budget.receipt({});
  assert.equal((row.admitted as unknown[]).length, 32);
  assert.equal((row.deferred as {reason: string}[])[0]!.reason, 'operation-count');
  assert.throws(() => censusParentBudget(110000, () => 0, {captureBytes: 257 * 1024 ** 2}));
});

test('budgeted census separates file groups and runs native children with one worker and bounded output', async t => {
  await loadBudget();
  const groups: string[][] = [];
  const input = {changed: ['lib/a.ts'], readHead: () => '', readBase: () => '',
    loadMembers: () => ['a', 'b'].map(name => ({testFile: `test/${name}.test.ts`, script: '', walks: ['lib/']})),
    runSuites: (files: string[]) => {groups.push(files); return [];}};
  census.evaluateAdmittedCensusSuites(input); assert.equal(groups.length, 1);
  groups.length = 0;
  census.evaluateAdmittedCensusSuites({...input, separateChildren: true});
  assert.deepEqual(groups, [['test/a.test.ts'], ['test/b.test.ts']]);
  const f = fixture(t), observations: {args: string[]; maxBuffer: number}[] = [];
  const run = (_file: string, args: string[], options: {maxBuffer: number}) => {
    observations.push({args, maxBuffer: options.maxBuffer});
    return {status: 0, stdout: 'TAP version 13\nok 1 - native case\n1..1\n# tests 1\n# pass 1\n# fail 0\n# cancelled 0\n# skipped 0\n# todo 0\n'};
  };
  census.runCensusSuitesViaChild({root: f.dir, files: ['test/a.test.ts'], run,
    parentBudget: censusParentBudget(110000, () => 0, {captureBytes: 64 * 1024 ** 2})});
  assert.ok(observations[0]!.args.includes('--test-concurrency=1'));
  assert.equal(observations[0]!.maxBuffer, 2 * 1024 ** 2);
  census.runCensusSuitesViaChild({root: f.dir, files: ['test/a.test.ts'], run});
  assert.equal(observations[1]!.maxBuffer, 64 * 1024 ** 2);
});

test('a rejected real native census capture survives outside disposable fixture scratch', async t => {
  await loadBudget();
  const f = fixture(t), captureRoot = join(f.dir, 'coverage', 'native');
  mkdirSync(captureRoot, {recursive: true});
  writeFileSync(join(f.dir, 'test/a.test.ts'), 'import{test}from"node:test";test("retained native failure",()=>{throw Error("retain this failure")});\n');
  const failed = census.runCensusSuitesViaChild({root: f.dir, files: ['test/a.test.ts'], captureRoot,
    parentBudget: censusParentBudget(110000)});
  assert.deepEqual(failed, ['test/a.test.ts']);
  const dirs = readdirSync(captureRoot); assert.equal(dirs.length, 1);
  const captured = join(captureRoot, dirs[0]!);
  assert.match(readFileSync(join(captured, 'stdout'), 'utf8'), /not ok/);
  assert.equal(JSON.parse(readFileSync(join(captured, 'native.json'), 'utf8')).status, 1);
});

test('partial census consumer binds actual context and rejects failures, truncation and unknown rows', async () => {
  await loadBudget();
  const {identity, row} = partial();
  const result = {status: 3, stderr: prefix + JSON.stringify(row), outputComplete: true};
  assert.ok(readCensusParentBudgetResult(result, identity));
  for (const mutation of [{status: 1}, {status: 2}, {signal: 'SIGTERM'}, {error: Error('timeout')},
    {outputComplete: false}, {stderr: prefix + '{'}, {stderr: result.stderr + '\n' + result.stderr},
    {stderr: result.stderr + '\ncensus-precheck: could not measure — unrelated failure'}])
    assert.equal(readCensusParentBudgetResult({...result, ...mutation}, identity), undefined);
  for (const key of ['root', 'head', 'requestedBase', 'budgetMs'])
    assert.equal(readCensusParentBudgetResult(result, {...identity, [key]: 'different'}), undefined);
  for (const mutation of [{deferred: []}, {completed: null}, {state: 'passed'},
    {deferred: [{label: 'would-fit', files: [], requiredMs: 60000, remainingMs: 62000}]}])
    assert.equal(readCensusParentBudgetResult({...result, stderr: prefix + JSON.stringify({...row, ...mutation})}, identity), undefined);
});

test('real census main defers unstarted expensive work with a context-bound partial receipt', async t => {
  await loadBudget();
  const f = fixture(t); let children = 0;
  const result = capture(t, () => census.main(['--root', f.dir, '--base', 'main', '--parent-budget-ms', '1'],
    {admitted: () => {children++; throw Error('must not start');}, runSuites: () => {children++; return [];}}));
  assert.equal(result.status, 3, result.stderr); assert.equal(children, 0);
  const row = readCensusParentBudgetResult(result, {root: f.dir, head: f.git('rev-parse', 'HEAD').trim(), requestedBase: 'main', budgetMs: 1});
  assert.ok(row); assert.equal((row.completed as unknown[]).length, 0);
});

test('a complete budgeted census keeps real native success instead of reporting partial', async t => {
  await loadBudget();
  // Install the positive child in the base too. Adding its fs import only at head
  // would correctly join structural censuses this tiny fixture does not contain.
  const f = fixture(t, false,
    'import{test}from"node:test";import{writeFileSync}from"node:fs";test("completed child",()=>writeFileSync("completed-child","yes"));\n');
  const result = capture(t, () => census.main(['--root', f.dir, '--base', 'main', '--parent-budget-ms', '110000'], {
    admitted: () => [{testFile: 'test/a.test.ts', script: '', walks: ['lib/']}],
  }));
  assert.equal(result.status, 0, result.stderr);
  assert.equal(readFileSync(join(f.dir, 'completed-child'), 'utf8'), 'yes');
  assert.ok(!result.stderr.includes(prefix));
});

test('unbudgeted census keeps its original behavior and never reads the parent clock', async t => {
  await loadBudget();
  const f = fixture(t); let admitted = 0;
  const result = capture(t, () => census.main(['--root', f.dir, '--base', 'main'],
    {admitted: () => {admitted++; return [];}, now: () => {throw Error('not an opt-in budget');}}));
  assert.equal(result.status, 0, result.stderr); assert.equal(admitted, 1);
  assert.ok(!result.stderr.includes(prefix));
});

test('invalid census parent budget refuses before a child starts', async t => {
  await loadBudget();
  const f = fixture(t); let admitted = 0;
  const result = capture(t, () => census.main(['--root', f.dir, '--base', 'main', '--parent-budget-ms', '110001'],
    {admitted: () => {admitted++; return [];}}));
  assert.equal(result.status, 2); assert.equal(admitted, 0);
});

test('an unrelated unavailable instrument beside a deferred child stays unavailable', async t => {
  await loadBudget();
  const f = fixture(t, true); let at = 0;
  const result = capture(t, () => census.main(['--root', f.dir, '--base', 'main', '--parent-budget-ms', '110000'],
    {now: () => at, measure: () => {at = 105000; throw Error('unrelated instrument failure');}, admitted: () => []}));
  assert.equal(result.status, 2, result.stderr); assert.match(result.stderr, /unrelated instrument failure/);
  assert.ok(!result.stderr.includes(prefix));
});

test('a reported native census timeout is never a parent-budget deferral', async t => {
  await loadBudget();
  const f = fixture(t); const budget = censusParentBudget(110000)!;
  assert.throws(() => census.runCensusSuitesViaChild({root: f.dir, files: ['test/a.test.ts'], parentBudget: budget,
    run: () => ({status: null, error: Object.assign(Error('actual native timeout'), {code: 'ERR_AUTHOR_STEP_TIMEOUT'})})}),
  error => !budget.owns(error));
});

test('budgeted census refuses a real native child before its whole backstop fits', async t => {
  await loadBudget();
  const f = fixture(t); let at = 0;
  writeFileSync(join(f.dir, 'test/a.test.ts'),
    'import{test}from"node:test";import{writeFileSync}from"node:fs";test("unstarted child",()=>writeFileSync("child-started","yes"));\n');
  const budget = censusParentBudget(110000, () => at)!; at = 105000;
  assert.throws(() => census.runCensusSuitesViaChild({root: f.dir, files: ['test/a.test.ts'], parentBudget: budget}),
    error => budget.owns(error));
  assert.equal(existsSync(join(f.dir, 'child-started')), false);
});

test('a real failing head with an unstarted base remains unavailable rather than partial', async t => {
  await loadBudget();
  const f = fixture(t); let at = 0;
  writeFileSync(join(f.dir, 'test/a.test.ts'), 'import{test}from"node:test";test("native census case",()=>{throw Error("head failure")});\n');
  f.git('add', '.'); f.git('commit', '-m', 'test: native head failure');
  const result = capture(t, () => census.main(['--root', f.dir, '--base', 'main', '--parent-budget-ms', '110000'], {
    now: () => at, admitted: () => [{testFile: 'test/a.test.ts', script: '', walks: ['lib/']}],
    runSuites: (input: CensusInput) => {const failed = census.runCensusSuitesViaChild(input); at = 105000; return failed;},
  }));
  assert.equal(result.status, 2, result.stderr); assert.match(result.stderr, /merge-base census run could not be measured/);
  assert.ok(!result.stderr.includes(prefix));
});

test('budgeted census preserves an actual head-red base-green assertion failure', async t => {
  await loadBudget();
  const f = fixture(t);
  writeFileSync(join(f.dir, 'test/a.test.ts'), 'import{test}from"node:test";test("native census case",()=>{throw Error("head failure")});\n');
  f.git('add', '.'); f.git('commit', '-m', 'test: native caused failure');
  const result = capture(t, () => census.main(['--root', f.dir, '--base', 'main', '--parent-budget-ms', '110000'], {
    admitted: () => [{testFile: 'test/a.test.ts', script: '', walks: ['lib/']}],
  }));
  assert.equal(result.status, 1, result.stderr); assert.match(result.stderr, /test\/a.test.ts fails/);
  assert.ok(!result.stderr.includes(prefix));
});

test('ordinary bounded author continues after a genuine partial producer and never claims PASS',
  {skip: process.platform !== 'darwin' ? 'actual bounded-volume author requires Mac' : false}, async t => {
  await loadBudget();
  const f = makeRuntimeFixture(); t.after(() => f.cleanup());
  const packages = Object.fromEntries(['tsx', 'typescript', '@commitlint/cli'].map(name =>
    [`node_modules/${name}`, {version: JSON.parse(readFileSync(join(f.dir, 'node_modules', name, 'package.json'), 'utf8')).version}]));
  writeFileSync(join(f.dir, 'package-lock.json'), JSON.stringify({lockfileVersion: 3, packages}));
  writeFileSync(join(f.dir, 'scripts/census-precheck.mjs'),
    `import{main}from ${JSON.stringify(pathToFileURL(join(REPO_ROOT, 'scripts/census-precheck.mjs')).href)};` +
    'let reads=0;process.exitCode=main(process.argv.slice(2),{now:()=>reads++===0?0:105000,admitted:()=>{throw Error("unstarted child")}});\n');
  f.git('add', '.'); f.git('commit', '-m', 'test: actual partial census producer');
  const result = authorMain(['--bounded-scratch-mib', '64'], {root: f.dir,
    select: () => ({fullRun: false, suites: ['test/a.test.ts'], reasons: ['partial producer integration']}),
    admitHost: () => ({state: 'admitted', fixtureOnly: true})});
  const row = JSON.parse(readFileSync(join(f.dir, 'coverage/preflight-author.json'), 'utf8'));
  assert.equal(result, 3, JSON.stringify(row)); assert.equal(row.verdict, 'over-capacity');
  assert.ok(['acquired', 'inherited'].includes(row.censusTestSlot.outcome));
  assert.equal(row.censusTestSlot.concurrency, 1);
  assert.equal(row.steps.find((x: {name: string}) => x.name === 'census-precheck').partial, true);
  assert.equal(row.steps.find((x: {name: string}) => x.name === 'affected-tests').ok, true);
  assert.equal(row.resourceBudget.cleanup, 'closed-and-removed');
});

test('ordinary bounded author refuses a native timeout even when the legacy producer marks it time-bound',
  {skip: process.platform !== 'darwin' ? 'actual bounded-volume author requires Mac' : false}, async t => {
  await loadBudget();
  const f = makeRuntimeFixture(); t.after(() => f.cleanup());
  const packages = Object.fromEntries(['tsx', 'typescript', '@commitlint/cli'].map(name =>
    [`node_modules/${name}`, {version: JSON.parse(readFileSync(join(f.dir, 'node_modules', name, 'package.json'), 'utf8')).version}]));
  writeFileSync(join(f.dir, 'package-lock.json'), JSON.stringify({lockfileVersion: 3, packages}));
  writeFileSync(join(f.dir, 'scripts/census-precheck.mjs'),
    'console.error("census-precheck: census suites NOT MEASURED (time bound) - fixture native backstop");process.exitCode=2;\n');
  f.git('add', '.'); f.git('commit', '-m', 'test: legacy native timeout producer');
  const result = authorMain(['--bounded-scratch-mib', '64'], {root: f.dir,
    select: () => ({fullRun: false, suites: ['test/a.test.ts'], reasons: ['native timeout refusal']}),
    admitHost: () => ({state: 'admitted', fixtureOnly: true})});
  const row = JSON.parse(readFileSync(join(f.dir, 'coverage/preflight-author.json'), 'utf8'));
  assert.equal(result, 1); assert.equal(row.verdict, 'refused');
  assert.equal(row.steps.find((x: {name: string}) => x.name === 'census-precheck').ok, false);
  assert.equal(row.steps.some((x: {name: string}) => x.name === 'static-preflight'), false);
  assert.ok(['acquired', 'inherited'].includes(row.censusTestSlot.outcome));
  assert.equal(row.resourceBudget.cleanup, 'closed-and-removed');
});
