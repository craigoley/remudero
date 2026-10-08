import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { getPriority } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { gitRepo } from './helpers/git-repo.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = join(ROOT, 'scripts/preflight-author.mjs');
const mod = (existsSync(SCRIPT) ? await import(pathToFileURL(SCRIPT).href) : {}) as {
  verifiedSuites: (root: string, suites: string[]) => string[];
  completeTestResult: (result: { status: number | null; stdout?: string; signal?: string; error?: Error }) => boolean;
  authorEnvironment: (parent: NodeJS.ProcessEnv) => NodeJS.ProcessEnv;
  main: (argv: string[], deps: { root: string; select?: (changed: string[]) => unknown; spawn?: typeof spawnSync }) => number;
};

function fixture(baseline: Record<string, string> = {}) {
  const repo = gitRepo({ kind: 'author-preflight', seedCommit: false });
  const root = repo.dir;
  for (const path of ['test/setup', 'src', 'scripts']) mkdirSync(join(root, path), { recursive: true });
  writeFileSync(join(root, '.nvmrc'), process.versions.node + '\n');
  writeFileSync(join(root, '.gitignore'), 'node_modules\ncoverage\n');
  symlinkSync(join(ROOT, 'node_modules'), join(root, 'node_modules'));
  writeFileSync(join(root, 'scripts/diff-class.mjs'), '// This fixture has no census path readers.\n');
  writeFileSync(join(root, 'scripts/census-precheck.mjs'), "console.log('fixture census precheck passed');\n");
  writeFileSync(join(root, 'test/setup/tmp-hygiene.ts'), 'export {};\n');
  writeFileSync(join(root, 'src/run-task.ts'), "console.log('fixture static preflight passed');\n");
  writeFileSync(join(root, 'src/leaf.ts'), 'export const value = 1;\n');
  writeFileSync(join(root, 'test/leaf.test.ts'), "import { test } from 'node:test'; import assert from 'node:assert/strict'; import { value } from '../src/leaf.js'; test('leaf', () => assert.equal(value, 1));\n");
  writeFileSync(join(root, 'test/other.test.ts'), "import { test } from 'node:test'; test('unrelated', () => {});\n");
  for (const [path, content] of Object.entries(baseline)) writeFileSync(join(root, path), content);
  const git = (...args: string[]) => repo.git(...args);
  git('add', '.');
  git('commit', '-m', 'test: baseline');
  git('remote', 'add', 'origin', root);
  git('checkout', '-b', 'run-unfiled-author-fixture');
  writeFileSync(join(root, 'src/leaf.ts'), 'export const value = 2;\n');
  writeFileSync(join(root, 'test/leaf.test.ts'), "import { test } from 'node:test'; import assert from 'node:assert/strict'; import { value } from '../src/leaf.js'; test('leaf', () => { assert.equal(value, 2); assert.equal(process.env.NODE_V8_COVERAGE, ''); });\n");
  git('add', '.');
  git('commit', '-m', 'fix: change the leaf');
  return { root, git, receipt: () => JSON.parse(readFileSync(join(root, 'coverage/preflight-author.json'), 'utf8')) };
}

test('author preflight runs real affected tests without coverage and records exact tree scope', () => {
  assert.equal(typeof mod.main, 'function', 'the shipped author gate must exist, including at the proof base');
  const f = fixture();
  assert.equal(mod.main([], { root: f.root }), 0);
  const receipt = f.receipt();
  assert.equal(receipt.verdict, 'passed');
  assert.equal(receipt.assurance, 'author-only');
  assert.equal(receipt.hostedFullSuiteAndCoverage, 'required-pending');
  assert.equal(receipt.headSha, f.git('rev-parse', 'HEAD'));
  assert.equal(receipt.baseSha, f.git('rev-parse', 'main'));
  assert.equal(receipt.selection, 'affected-narrow');
  assert.deepEqual(receipt.suites, ['test/leaf.test.ts']);
  assert.deepEqual(receipt.steps.map((s: { ok: boolean }) => s.ok), [true, true, true]);
  assert.deepEqual(receipt.gitHistory, { state: 'complete' });
});

test('author static preflight lowers real descendant priority and records the actual wrapper', () => {
  const f = fixture();
  const parentPriority = getPriority();
  writeFileSync(join(f.root, 'src/run-task.ts'), `
    import { getPriority } from 'node:os';
    import { spawnSync } from 'node:child_process';
    import { writeFileSync } from 'node:fs';
    const child = spawnSync(process.execPath, ['-e', 'console.log(require("node:os").getPriority())'], {encoding:'utf8'});
    if (child.status !== 0) throw new Error('descendant priority probe failed');
    writeFileSync('coverage/static-priority.json', JSON.stringify({self:getPriority(), child:Number(child.stdout)}));
  `);
  f.git('add', '.'); f.git('commit', '-m', 'test: real descendant priority');
  assert.equal(mod.main([], { root: f.root }), 0);
  const receipt = f.receipt();
  const step = receipt.steps.find((row: {name: string}) => row.name === 'static-preflight');
  assert.ok(['nice', 'nice+ionice'].includes(step.priority));
  const observed = JSON.parse(readFileSync(join(f.root, 'coverage/static-priority.json'), 'utf8'));
  assert.equal(observed.self, Math.min(19, parentPriority + 10));
  assert.equal(observed.child, observed.self, 'the entire static process tree inherits lower CPU priority');
  assert.equal(receipt.verdict, 'passed');
  assert.deepEqual(receipt.steps.map((row: {name: string}) => row.name), ['census-precheck', 'static-preflight', 'affected-tests']);
});

test('author static priority wrapping retains failure and never starts affected tests', () => {
  const f = fixture();
  writeFileSync(join(f.root, 'src/run-task.ts'), 'process.exitCode = 7;\n');
  f.git('add', '.'); f.git('commit', '-m', 'test: failed low priority static');
  assert.equal(mod.main([], { root: f.root }), 1);
  const receipt = f.receipt();
  assert.equal(receipt.verdict, 'failed');
  assert.deepEqual(receipt.steps.map((row: {name: string}) => row.name), ['census-precheck', 'static-preflight']);
  assert.equal(receipt.steps[1].exitCode, 7);
  assert.ok(['nice', 'nice+ionice'].includes(receipt.steps[1].priority));
  assert.match(receipt.affectedTestsNotRunReason, /static-preflight did not succeed/);
});

test('author preflight refuses shared bare configuration before a real split-config migration can poison sibling worktrees', (t) => {
  const f = fixture(), bare = gitRepo({ bare: true, kind: 'author-bare-topology' });
  t.after(() => bare.cleanup());
  bare.git('fetch', f.root, 'refs/heads/main:refs/heads/main',
    'refs/heads/run-unfiled-author-fixture:refs/heads/author');
  bare.git('remote', 'add', 'origin', f.root);
  bare.git('config', 'remote.origin.fetch', '+refs/heads/main:refs/remotes/origin/main');
  const paths = [join(bare.dir, 'first'), join(bare.dir, 'second')];
  for (const path of paths) bare.git('worktree', 'add', '--detach', path, 'author');
  const git = (path: string, ...args: string[]) => bare.git('-C', path, ...args);
  const receipt = () => JSON.parse(readFileSync(join(paths[0], 'coverage/preflight-author.json'), 'utf8'));
  let selected = 0;
  const select = () => { selected++; return { fullRun: true, suites: [], reasons: ['fixture'] }; };
  for (const path of paths) assert.equal(git(path, 'rev-parse', '--is-inside-work-tree'), 'true');
  for (const argv of [[], ['--dry-run']]) {
    assert.equal(mod.main(argv, { root: paths[0], select }), 1);
    assert.equal(receipt().gitTopology.state, 'hazardous-common-config');
    assert.match(receipt().error, /owned, idle worktreeConfig migration/);
    assert.deepEqual(receipt().steps, []);
    assert.equal(receipt().testSlot, undefined);
  }
  assert.equal(selected, 0);
  assert.equal(bare.git('config', '--local', '--get', 'core.bare'), 'true', 'the gate never migrates shared state');
  // Positive defect control: this real Git transition breaks BOTH linked working trees.
  bare.git('config', '--local', 'extensions.worktreeConfig', 'true');
  for (const path of paths) assert.equal(git(path, 'rev-parse', '--is-inside-work-tree'), 'false');
  assert.equal(mod.main([], { root: paths[0], select }), 1);
  assert.equal(receipt().gitTopology.state, 'not-worktree');
  assert.equal(selected, 0);
  // Only the fixture owner performs Git's documented main-worktree migration.
  bare.git('config', '--worktree', 'core.bare', 'true');
  bare.git('config', '--local', '--unset', 'core.bare');
  assert.equal(bare.git('rev-parse', '--is-bare-repository'), 'true');
  for (const path of paths) assert.equal(git(path, 'rev-parse', '--is-inside-work-tree'), 'true');
  assert.equal(mod.main(['--dry-run'], { root: paths[0], select }), 0);
  assert.equal(selected, 1);
  assert.equal(receipt().gitTopology.state, 'safe');
  assert.equal(receipt().verdict, 'not-run', 'a dry-run topology control is not author assurance');
});

test('author preflight refuses shared core.worktree before selection without changing the operator configuration', () => {
  const f = fixture();
  f.git('config', '--local', 'core.worktree', f.root);
  let selected = 0;
  const select = () => { selected++; return { fullRun: true, suites: [], reasons: ['fixture'] }; };
  assert.equal(mod.main([], { root: f.root, select }), 1);
  assert.equal(selected, 0);
  assert.equal(f.receipt().gitTopology.state, 'hazardous-common-config');
  assert.equal(f.git('config', '--local', '--get', 'core.worktree'), f.root);
  assert.deepEqual(f.receipt().steps, []);
  f.git('config', '--local', '--unset', 'core.worktree');
  assert.equal(mod.main(['--dry-run'], { root: f.root, select }), 0);
  assert.equal(selected, 1);
});

test('author preflight preserves unreadable or ambiguous Git topology as refusal rather than safe admission', () => {
  for (const result of [
    { status: 128, stdout: '', stderr: 'fixture unreadable config', signal: null },
    { status: null, stdout: '', stderr: '', signal: 'SIGTERM' },
    { status: null, stdout: '', stderr: '', signal: null, error: new Error('fixture Git spawn failure') },
    { status: 0, stdout: 'unavailable\n', stderr: '', signal: null },
    { status: 1, stdout: 'false\n', stderr: '', signal: null },
  ]) {
    const f = fixture();
    let selected = false;
    const spawn = ((file: string, args: string[], opts: Parameters<typeof spawnSync>[2]) =>
      file === 'git' && args.includes('core.bare')
        ? { ...result, pid: 0, output: [] } : spawnSync(file, args, opts)) as typeof spawnSync;
    assert.equal(mod.main([], { root: f.root, spawn, select: () => { selected = true; return {}; } }), 1);
    assert.equal(selected, false);
    assert.equal(f.receipt().gitTopology.state, 'unknown');
    assert.deepEqual(f.receipt().gitTopology.reads, [{ key: 'core.bare', status: result.status,
      signal: result.signal, error: 'error' in result ? result.error?.message ?? null : null }]);
    assert.match(f.receipt().error, /shared Git core.bare is (unreadable|ambiguous)/);
    assert.deepEqual(f.receipt().steps, []);
  }
});

test('author preflight never admits an ambiguous working-tree read as a safe Git topology', () => {
  for (const stdout of ['', 'false\ntrue\n', 'unavailable\n']) {
    const f = fixture();
    let selected = false;
    const spawn = ((file: string, args: string[], opts: Parameters<typeof spawnSync>[2]) =>
      file === 'git' && args.includes('--is-inside-work-tree')
        ? { status: 0, stdout, stderr: '', signal: null, pid: 0, output: [] }
        : spawnSync(file, args, opts)) as typeof spawnSync;
    assert.equal(mod.main([], { root: f.root, spawn, select: () => { selected = true; return {}; } }), 1);
    assert.equal(selected, false);
    assert.equal(f.receipt().gitTopology.state, 'unknown');
    assert.deepEqual(f.receipt().gitTopology.reads, []);
    assert.deepEqual(f.receipt().steps, []);
  }
});

test('author preflight refuses a real shallow boundary before selection or expensive validation even when every object is present', () => {
  const f = fixture();
  const head = f.git('rev-parse', 'HEAD');
  const parent = f.git('rev-parse', 'HEAD^');
  const boundary = join(f.root, '.git', 'shallow');
  // Only this freshly initialized fixture is changed. Its parent object remains present,
  // reproducing a boundary that survives a bundle import of otherwise complete objects.
  writeFileSync(boundary, head + '\n');
  assert.equal(f.git('rev-parse', '--is-shallow-repository'), 'true');
  assert.equal(f.git('cat-file', '-t', parent), 'commit');
  let selections = 0;
  const select = () => { selections++; return { fullRun: true, suites: [], reasons: ['fixture full floor'] }; };
  for (const argv of [[], ['--dry-run']]) {
    assert.equal(mod.main(argv, { root: f.root, select }), 1);
    const receipt = f.receipt();
    assert.equal(receipt.verdict, 'refused');
    assert.deepEqual(receipt.gitHistory, { state: 'shallow' });
    assert.match(receipt.error, /complete Git history required.*git fetch --unshallow/);
    assert.equal(selections, 0);
    assert.deepEqual(receipt.steps, []);
    assert.deepEqual(receipt.suites, []);
    assert.equal(receipt.testSlot, undefined);
  }
  unlinkSync(boundary); // Only this test's generated boundary, never a host repository.
  assert.equal(f.git('rev-parse', '--is-shallow-repository'), 'false');
  assert.equal(mod.main(['--dry-run'], { root: f.root, select }), 0);
  assert.equal(selections, 1, 'positive control: complete history actually reaches selection');
  assert.equal(f.receipt().selection, 'full-fallback');
  assert.deepEqual(f.receipt().gitHistory, { state: 'complete' });
  assert.equal(f.git('rev-parse', 'HEAD'), head);
});

test('author preflight refuses ambiguous history output before selection without inventing complete history', () => {
  for (const stdout of ['', 'false\ntrue\n', 'unavailable\n']) {
    const f = fixture();
    let selected = false;
    const spawn = ((file: string, args: string[], opts: Parameters<typeof spawnSync>[2]) =>
      file === 'git' && args.includes('--is-shallow-repository')
        ? { status: 0, stdout, stderr: '', signal: null, pid: 0, output: [] }
        : spawnSync(file, args, opts)) as typeof spawnSync;
    assert.equal(mod.main([], { root: f.root, spawn, select: () => { selected = true; return {}; } }), 1);
    assert.equal(selected, false);
    assert.deepEqual(f.receipt().gitHistory, { state: 'unknown' });
    assert.match(f.receipt().error, /completeness is unavailable/);
    assert.deepEqual(f.receipt().steps, []);
  }
});

test('author preflight preserves native history read failures and signals before expensive validation', () => {
  const failures = [
    { status: 1, stdout: 'false\n', stderr: 'fixture Git history refusal', signal: null },
    { status: null, stdout: 'false\n', stderr: '', signal: 'SIGTERM' },
    { status: null, stdout: 'false\n', stderr: '', signal: null, error: new Error('fixture Git history unreadable') },
  ];
  for (const failure of failures) {
    const f = fixture();
    let selected = false;
    const spawn = ((file: string, args: string[], opts: Parameters<typeof spawnSync>[2]) =>
      file === 'git' && args.includes('--is-shallow-repository')
        ? { ...failure, pid: 0, output: [] }
        : spawnSync(file, args, opts)) as typeof spawnSync;
    assert.equal(mod.main([], { root: f.root, spawn, select: () => { selected = true; return {}; } }), 1);
    assert.equal(selected, false);
    assert.deepEqual(f.receipt().gitHistory, { state: 'unknown' });
    assert.match(f.receipt().error, /git rev-parse --is-shallow-repository failed/);
    assert.deepEqual(f.receipt().steps, []);
  }
});

test('author preflight clears foreign Git scope without hiding a dirty intended tree', () => {
  const f = fixture();
  const foreign = fixture();
  foreign.git('commit', '--allow-empty', '-m', 'test: foreign Git scope');
  const env = { ...process.env, GIT_DIR: join(foreign.root, '.git'), GIT_WORK_TREE: foreign.root,
    GIT_INDEX_FILE: join(foreign.root, '.git/index'), GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'core.worktree', GIT_CONFIG_VALUE_0: foreign.root };
  const invoke = () => spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e',
    `import { main } from ${JSON.stringify(pathToFileURL(SCRIPT).href)}; process.exit(main([], { root: ${JSON.stringify(f.root)} }));`],
  { cwd: ROOT, encoding: 'utf8', env });
  const before = foreign.git('rev-parse', 'HEAD');
  const result = invoke();
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(f.receipt().verdict, 'passed');
  assert.equal(f.receipt().headSha, f.git('rev-parse', 'HEAD'));
  assert.notEqual(f.receipt().headSha, before);
  writeFileSync(join(f.root, 'untracked.ts'), 'export {};');
  assert.equal(invoke().status, 1, 'a clean foreign repository cannot conceal intended-tree changes');
  assert.equal(f.receipt().verdict, 'refused');
  assert.match(f.receipt().error, /uncommitted or untracked/);
  assert.equal(foreign.git('rev-parse', 'HEAD'), before);
  assert.equal(foreign.git('status', '--porcelain'), '');
  const names = spawnSync('git', ['rev-parse', '--local-env-vars'], { cwd: ROOT, encoding: 'utf8' });
  assert.equal(names.status, 0, names.stderr);
  const keys = [...names.stdout.trim().split('\n'), 'GIT_NAMESPACE', 'GIT_QUARANTINE_PATH',
    'GIT_INTERNAL_SUPER_PREFIX'];
  const parent = Object.fromEntries(keys.map(key => [key, 'foreign'])) as NodeJS.ProcessEnv;
  parent.GIT_SSH_COMMAND = 'fixture-transport';
  const original = { ...parent };
  const sanitized = mod.authorEnvironment(parent);
  for (const key of keys) assert.equal(sanitized[key], undefined, `${key} must not redirect child Git`);
  assert.equal(sanitized.GIT_SSH_COMMAND, 'fixture-transport', 'transport configuration is not repository scope');
  assert.deepEqual(parent, original, 'do not mutate the caller environment');
});

test('author preflight full fallback includes unrelated tests for unmodelled configuration', () => {
  const f = fixture();
  writeFileSync(join(f.root, 'package-lock.json'), '{}\n');
  f.git('add', '.'); f.git('commit', '-m', 'test: change dependency inputs');
  assert.equal(mod.main([], { root: f.root }), 0);
  assert.equal(f.receipt().selection, 'full-fallback');
  assert.deepEqual(f.receipt().suites, ['test/leaf.test.ts', 'test/other.test.ts']);
});

test('author preflight catches census failures before expensive validation and records unreadable census refusal', () => {
  for (const status of [1, 2]) {
    const f = fixture();
    writeFileSync(join(f.root, 'scripts/census-precheck.mjs'), `process.exitCode = ${status};\n`);
    writeFileSync(join(f.root, 'src/run-task.ts'), "import { writeFileSync, mkdirSync } from 'node:fs'; mkdirSync('coverage', { recursive: true }); writeFileSync('coverage/expensive-started', 'yes');\n");
    f.git('add', '.'); f.git('commit', '-m', 'test: reject census before validation');
    assert.equal(mod.main([], { root: f.root }), 1);
    assert.equal(f.receipt().verdict, status === 2 ? 'refused' : 'failed');
    assert.equal(f.receipt().steps.length, 1);
    assert.equal(f.receipt().steps[0].name, 'census-precheck');
    assert.equal(f.receipt().steps[0].ok, false);
    assert.equal(existsSync(join(f.root, 'coverage/expensive-started')), false);
  }
});

test('author preflight refuses a real test failure and preserves its failed receipt', () => {
  const f = fixture();
  writeFileSync(join(f.root, 'src/leaf.ts'), 'export const value = 3;\n');
  f.git('add', '.'); f.git('commit', '-m', 'test: break the leaf');
  assert.equal(mod.main([], { root: f.root }), 1);
  assert.equal(f.receipt().verdict, 'failed');
  assert.equal(f.receipt().steps[2].ok, false);
});

test('author preflight refuses static failure, a mutated tree and an unwritable receipt', () => {
  const staticRed = fixture();
  writeFileSync(join(staticRed.root, 'src/run-task.ts'), 'process.exitCode = 1;\n');
  staticRed.git('add', '.'); staticRed.git('commit', '-m', 'test: fail the static gate');
  assert.equal(mod.main([], { root: staticRed.root }), 1);
  assert.equal(staticRed.receipt().steps[1].ok, false);
  assert.equal(staticRed.receipt().verdict, 'failed');
  assert.equal(staticRed.receipt().steps.length, 2, 'failed static evidence is retained without starting another run');
  assert.match(staticRed.receipt().affectedTestsNotRunReason, /static-preflight did not succeed/);
  const mutated = fixture();
  writeFileSync(join(mutated.root, 'src/run-task.ts'), "import { writeFileSync } from 'node:fs'; writeFileSync('untracked.ts', 'export {};');\n");
  mutated.git('add', '.'); mutated.git('commit', '-m', 'test: mutate the author tree');
  assert.equal(mod.main([], { root: mutated.root }), 1);
  assert.match(mutated.receipt().error, /tree changed during verification/);
  const unwritable = fixture();
  writeFileSync(join(unwritable.root, 'coverage'), 'not a directory');
  assert.equal(mod.main([], { root: unwritable.root }), 1, 'unrecordable results must not be reusable greens');
});

test('author preflight refuses dirty, stale-base, empty-diff, wrong-runtime and ghost-file claims', () => {
  const f = fixture();
  writeFileSync(join(f.root, 'untracked.ts'), 'export {};');
  assert.equal(mod.main([], { root: f.root }), 1);
  assert.match(f.receipt().error, /uncommitted or untracked/);
  f.git('add', '.'); f.git('commit', '-m', 'test: track fixture');
  assert.equal(mod.main([], { root: f.root, select: () => ({ fullRun: false, suites: ['test/ghost.test.ts'], reasons: [] }) }), 1);
  assert.match(f.receipt().error, /ENOENT/);
  f.git('remote', 'set-url', 'origin', join(f.root, 'absent-origin'));
  assert.equal(mod.main([], { root: f.root }), 1);
  assert.match(f.receipt().error, /git fetch origin main failed/);
  f.git('remote', 'set-url', 'origin', f.root);
  f.git('checkout', 'main');
  assert.equal(mod.main([], { root: f.root }), 1);
  assert.match(f.receipt().error, /empty author diff/);
  writeFileSync(join(f.root, '.nvmrc'), '0.0.0\n');
  assert.equal(mod.main([], { root: f.root }), 1);
  assert.match(f.receipt().error, /Node 0.0.0 required/);
});

test('author preflight dry run never claims tests passed and empty selection falls back to all tests', () => {
  const f = fixture();
  assert.equal(mod.main(['--dry-run'], { root: f.root, select: () => ({ fullRun: false, suites: [], reasons: [] }) }), 0);
  assert.equal(f.receipt().verdict, 'not-run');
  assert.deepEqual(f.receipt().steps, []);
  assert.equal(f.receipt().selection, 'full-fallback');
  assert.equal(f.receipt().suites.length, 2);
  assert.match(f.receipt().reasons[0], /zero-test green/);
});

test('author preflight rejects green exit without a positive complete test summary', () => {
  assert.equal(mod.completeTestResult({ status: 0, stdout: '# tests 1\n# pass 1\n# fail 0\n' }), true);
  for (const result of [
    { status: 0, stdout: 'ok 1 - test/ghost.test.ts' },
    { status: 0, stdout: '# tests 0\n# fail 0\n' },
    { status: 0, stdout: '# tests 1\n# pass 0\n# fail 0\n# skipped 1\n' },
    { status: 0, stdout: '# tests 1\n# fail 0\n' },
    { status: 0, stdout: '# tests 1\n# fail 1\n' },
    { status: null, signal: 'SIGTERM', stdout: '# tests 1\n# fail 0\n' },
    { status: 1, stdout: '# tests 1\n# fail 0\n' },
    { status: 0, error: new Error('spawn failed'), stdout: '# tests 1\n# fail 0\n' },
  ]) assert.equal(mod.completeTestResult(result), false);
  const f = fixture();
  assert.deepEqual(mod.verifiedSuites(f.root, ['test/leaf.test.ts', 'test/leaf.test.ts']), ['test/leaf.test.ts']);
  assert.throws(() => mod.verifiedSuites(f.root, ['../outside.test.ts']), /unverified/);
});

test('author preflight rejects skipped-only verification and accepts a real pass beside a skip', () => {
  const f = fixture();
  const selection = () => ({ fullRun: false, suites: ['test/leaf.test.ts'], reasons: [] });
  writeFileSync(join(f.root, 'test/leaf.test.ts'), "import { test } from 'node:test'; test.skip('unsupported fixture', () => { throw Error('must not execute'); });\n");
  f.git('add', '.'); f.git('commit', '-m', 'test: skip the only affected test');
  assert.equal(mod.main([], { root: f.root, select: selection }), 1);
  assert.equal(f.receipt().verdict, 'failed');
  assert.equal(f.receipt().steps[2].exitCode, 0, 'a clean process exit is not an executed test');
  assert.equal(f.receipt().steps[2].ok, false);
  writeFileSync(join(f.root, 'test/leaf.test.ts'), "import { test } from 'node:test'; test('executed fixture', () => {}); test.skip('unsupported fixture', () => {});\n");
  f.git('add', '.'); f.git('commit', '-m', 'test: execute a pass beside a skip');
  assert.equal(mod.main([], { root: f.root, select: selection }), 0);
  assert.equal(f.receipt().verdict, 'passed');
  assert.equal(f.receipt().steps[2].ok, true);
});

test('author preflight starts affected tests only after a successful native static gate', () => {
  for (const outcome of ['passed', 'failed', 'signalled'] as const) {
    const f = fixture();
    const witness = join(f.root, 'coverage/affected-test-witness');
    writeFileSync(join(f.root, 'src/run-task.ts'), outcome === 'signalled'
      ? "process.kill(process.pid, 'SIGTERM');\n"
      : `console.log('native static witness'); process.exitCode = ${outcome === 'passed' ? 0 : 1};\n`);
    writeFileSync(join(f.root, 'test/leaf.test.ts'),
      "import { test } from 'node:test'; import { writeFileSync } from 'node:fs'; test('affected execution witness', () => writeFileSync('coverage/affected-test-witness', 'ran'));\n");
    f.git('add', '.'); f.git('commit', '-m', `test: static gate ${outcome}`);
    const select = () => ({ fullRun: false, suites: ['test/leaf.test.ts'], reasons: [] });
    assert.equal(mod.main([], { root: f.root, select }), outcome === 'passed' ? 0 : 1);
    const receipt = f.receipt();
    assert.deepEqual(receipt.suites, ['test/leaf.test.ts'], 'the selected floor is unchanged, not narrowed to avoid a red');
    assert.equal(receipt.verdict, outcome === 'passed' ? 'passed' : 'failed');
    assert.equal(existsSync(witness), outcome === 'passed', 'an unsuccessful static gate must not start known-doomed tests');
    assert.deepEqual(receipt.steps.map((step: { name: string }) => step.name), outcome === 'passed'
      ? ['census-precheck', 'static-preflight', 'affected-tests'] : ['census-precheck', 'static-preflight']);
    if (outcome !== 'passed') assert.match(receipt.affectedTestsNotRunReason, /static-preflight did not succeed/);
    else assert.equal(receipt.affectedTestsNotRunReason, undefined);
    if (outcome === 'signalled') assert.equal(receipt.steps[1].signal, 'SIGTERM');
    if (outcome === 'passed') assert.equal(receipt.steps[2].testSummary.tests, 1, 'positive control: a successful gate really executes its test');
  }
});

test('author preflight retains large real failures privately while keeping terminal feedback bounded', () => {
  const f = fixture();
  writeFileSync(join(f.root, 'test/leaf.test.ts'), "import { test } from 'node:test'; test('durable failure witness', () => { console.log('large-output:' + 'x'.repeat(90000)); console.error('stderr-witness'); throw Error('load-bearing failure witness'); });\n");
  f.git('add', '.'); f.git('commit', '-m', 'test: retain a large failure');
  const result = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e',
    `import { main } from ${JSON.stringify(pathToFileURL(SCRIPT).href)}; process.exit(main([], { root: ${JSON.stringify(f.root)} }));`],
  { cwd: ROOT, encoding: 'utf8' });
  assert.equal(result.status, 1);
  const receipt = f.receipt();
  assert.equal(receipt.verdict, 'failed');
  const step = receipt.steps.find((s: { name: string }) => s.name === 'affected-tests');
  assert.deepEqual(step.testSummary, { tests: 1, suites: 0, pass: 0, fail: 1, cancelled: 0, skipped: 0, todo: 0 });
  assert.ok(step.diagnostics.stdoutBytes > 90000);
  const path = join(f.root, step.diagnostics.stdout);
  const log = readFileSync(path, 'utf8');
  assert.match(log, /load-bearing failure witness/);
  assert.match(log, /^# fail 1$/m);
  assert.equal(statSync(path).mode & 0o077, 0, 'test output can contain private fixture evidence');
  const priorReceipt = readFileSync(join(dirname(path), 'receipt.json'), 'utf8');
  assert.equal(JSON.parse(priorReceipt).headSha, receipt.headSha);
  assert.ok(result.stdout.length + result.stderr.length < 30000, 'full noisy TAP belongs in the durable logs, not a truncated terminal');
  assert.match(result.stdout, /not ok .*durable failure witness/);
  assert.match(result.stdout, /complete output:/);
  assert.equal(mod.main(['--dry-run'], { root: f.root }), 0);
  assert.equal(readFileSync(join(dirname(path), 'receipt.json'), 'utf8'), priorReceipt, 'a later run must not overwrite the failure receipt');
});

test('author preflight records spawn errors and incomplete summaries instead of losing the failure cause', () => {
  const f = fixture();
  const result = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e',
    `import { spawnSync } from 'node:child_process'; import { main } from ${JSON.stringify(pathToFileURL(SCRIPT).href)};
    process.exit(main([], { root: ${JSON.stringify(f.root)}, spawn: (file, args, opts) => args.includes('--test')
      ? { status: null, signal: 'SIGTERM', stdout: 'partial diagnostic witness', stderr: 'buffer limit witness', error: Object.assign(new Error('buffer exhausted'), { code: 'ENOBUFS' }) }
      : spawnSync(file, args, opts) }));`],
  { cwd: ROOT, encoding: 'utf8' });
  assert.equal(result.status, 1);
  const step = f.receipt().steps.at(-1);
  assert.equal(step.ok, false);
  assert.equal(step.signal, 'SIGTERM');
  assert.deepEqual(step.error, { message: 'buffer exhausted', code: 'ENOBUFS' });
  assert.equal(step.testSummary, null);
  assert.equal(step.diagnostics.mayBeIncomplete, true);
  assert.match(readFileSync(join(f.root, step.diagnostics.stdout), 'utf8'), /partial diagnostic witness/);
  assert.match(readFileSync(join(f.root, step.diagnostics.stderr), 'utf8'), /buffer limit witness/);
});

test('author preflight leaves a running receipt and live private logs when its waiting parent is killed', async () => {
  const f = fixture();
  const release = join(f.root, 'coverage/release');
  writeFileSync(join(f.root, 'src/run-task.ts'), `import {existsSync} from 'node:fs'; console.log('live static witness'); console.error('live static stderr'); const timer=setInterval(()=>{if(existsSync(${JSON.stringify(release)})){clearInterval(timer);process.exitCode=7}},10);\n`);
  f.git('add', '.'); f.git('commit', '-m', 'test: hold native static step');
  const parent = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e',
    `import {main} from ${JSON.stringify(pathToFileURL(SCRIPT).href)}; process.exit(main([], {root:${JSON.stringify(f.root)}}));`],
  { cwd: ROOT, stdio: 'ignore' });
  const closed = new Promise<string | null>((resolve) => parent.once('close', (_code, signal) => resolve(signal)));
  const waitFor = async (predicate: () => boolean) => {
    for (let turn = 0; turn < 1000 && !predicate(); turn++) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.ok(predicate(), 'bounded native author witness never arrived');
  };
  let logRoot = '';
  try {
    await waitFor(() => {
      const coverage = join(f.root, 'coverage');
      if (!existsSync(coverage)) return false;
      const name = readdirSync(coverage).find((entry) => entry.startsWith('rmd-author-'));
      if (!name) return false;
      logRoot = join(coverage, name);
      const log = join(logRoot, 'static-preflight.stdout.log');
      return existsSync(log) && readFileSync(log, 'utf8').includes('live static witness');
    });
    const before = JSON.parse(readFileSync(join(logRoot, 'progress.json'), 'utf8'));
    assert.equal(before.verdict, 'running');
    assert.equal(before.currentStep.name, 'static-preflight');
    assert.equal(before.currentStep.outputLimitBytes, 100 * 1024 * 1024);
    assert.equal(before.headSha, f.git('rev-parse', 'HEAD'));
    assert.equal(statSync(logRoot).mode & 0o077, 0);
    assert.equal(parent.kill('SIGKILL'), true);
    assert.equal(await closed, 'SIGKILL');
    writeFileSync(release, 'release');
    const native = join(logRoot, 'static-preflight.native-result.json');
    await waitFor(() => existsSync(native));
    assert.equal(JSON.parse(readFileSync(native, 'utf8')).status, 7);
    assert.equal(JSON.parse(readFileSync(join(logRoot, 'progress.json'), 'utf8')).verdict, 'running');
    assert.equal(existsSync(join(logRoot, 'receipt.json')), false, 'loss of the author cannot certify a completed gate');
    assert.match(readFileSync(join(logRoot, 'static-preflight.stderr.log'), 'utf8'), /live static stderr/);
  } finally {
    mkdirSync(join(f.root, 'coverage'), { recursive: true });
    writeFileSync(release, 'release');
    if (parent.exitCode === null && parent.signalCode === null) parent.kill('SIGKILL');
  }
});

test('author preflight cannot publish a passed progress receipt when the authoritative receipt write fails', () => {
  const f = fixture();
  mkdirSync(join(f.root, 'coverage/preflight-author.json'), { recursive: true });
  assert.equal(mod.main([], { root: f.root }), 1);
  const coverage = join(f.root, 'coverage');
  const name = readdirSync(coverage).find((entry) => entry.startsWith('rmd-author-'))!;
  const progress = JSON.parse(readFileSync(join(coverage, name, 'progress.json'), 'utf8'));
  assert.notEqual(progress.verdict, 'passed', 'native success is not successful authoritative receipt publication');
  assert.equal(progress.verdict, 'refused');
  assert.match(progress.error, /receipt could not be written/);
});

test('preflight-author runs the narrow selection and its receipt records both the floor size and the narrow size', () => {
  // hub.ts imports leaf.ts but uses only `unchanged`; the branch changes only `value`. The floor's
  // import graph reaches hub.test.ts; the narrow arm (symbol reach) does not, so it is smaller.
  const f = fixture({
    'src/hub.ts': "import { value } from './leaf.js';\nexport const hub = 'hub';\nexport const unused = typeof value;\n",
    'test/hub.test.ts': "import { test } from 'node:test'; import { hub } from '../src/hub.js'; test('hub', () => { if (hub !== 'hub') throw Error(); });\n",
    'test/reads-leaf.test.ts': "import { test } from 'node:test'; test('reads', () => { void 'src/leaf.ts'; });\n",
  });
  assert.equal(mod.main(['--dry-run'], { root: f.root }), 0);
  const receipt = f.receipt();
  assert.equal(receipt.verdict, 'not-run');
  assert.deepEqual(receipt.steps, [], 'a dry run spawns no suite');
  assert.equal(receipt.selection, 'affected-narrow');
  assert.equal(receipt.floorSize, 3, 'floor: the changed test, the import-graph reach, the path namer');
  assert.equal(receipt.narrowSize, 2, 'narrow: the changed test and the suite naming the changed file by path');
  assert.deepEqual(receipt.suites, ['test/leaf.test.ts', 'test/reads-leaf.test.ts']);
  // An import-only edit names no symbol, so the narrow arm cannot reach the module: the floor runs.
  writeFileSync(join(f.root, 'src/hub.ts'), "import { value } from './leaf.js';\nimport './leaf.js';\nexport const hub = 'hub';\nexport const unused = typeof value;\n");
  f.git('add', '.'); f.git('commit', '-m', 'test: an import-only edit');
  assert.equal(mod.main(['--dry-run'], { root: f.root }), 0);
  assert.equal(f.receipt().selection, 'affected-floor');
  assert.equal(f.receipt().narrowSize, null);
  assert.equal(f.receipt().floorSize, f.receipt().suites.length);
  // A full-run trigger still selects every suite, with no floor or narrow size.
  writeFileSync(join(f.root, 'package.json'), '{}\n');
  f.git('add', '.'); f.git('commit', '-m', 'test: unmodelled input');
  assert.equal(mod.main(['--dry-run'], { root: f.root }), 0);
  assert.equal(f.receipt().selection, 'full-fallback');
  assert.deepEqual([f.receipt().floorSize, f.receipt().narrowSize], [null, null]);
  assert.equal(f.receipt().suites.length, 4);
});
