import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, readdirSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { gitRepo } from './helpers/git-repo.js';
const { main, OVER_CAPACITY_EXIT } = await import(new URL('../scripts/preflight-author.mjs', import.meta.url).href) as {
  main: (args: string[], options: { root: string;
    select: () => { fullRun: boolean; suites: string[]; reasons: string[] };
    host: () => { cores: number; load1: number; headroomBytes: number } }) => number;
  OVER_CAPACITY_EXIT: number;
};
const { AUTHOR_WORKFLOW_CONTRACT_SUITES, authorWorkflowContractInputs } =
  await import(new URL('../scripts/lib/author-workflow-contract.mjs', import.meta.url).href) as {
    AUTHOR_WORKFLOW_CONTRACT_SUITES: readonly [string, string];
    authorWorkflowContractInputs: (files: string[]) => string[];
  };

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PROBE = '.github/workflows/new-directory-member.yml';
const validWorkflow = `on: {pull_request: {}}
jobs:
  probe:
    runs-on: ubuntu-latest
    timeout-minutes: 1
    steps:
      - uses: actions/setup-node@${'a'.repeat(40)}
        with: {cache: npm}
`;

function fixture(t: { after: (fn: () => void) => void }) {
  const repo = gitRepo({ kind: 'author-workflow-contract', seedCommit: false });
  t.after(() => repo.cleanup());
  const put = (path: string, text: string) => {
    mkdirSync(dirname(join(repo.dir, path)), { recursive: true });
    writeFileSync(join(repo.dir, path), text);
  };
  // Use the real contracts and complete workflow corpus; all mutations stay in this private Git fixture.
  for (const name of readdirSync(join(ROOT, '.github/workflows'))) {
    put('.github/workflows/' + name, readFileSync(join(ROOT, '.github/workflows', name), 'utf8'));
  }
  for (const path of [...AUTHOR_WORKFLOW_CONTRACT_SUITES, '.nvmrc', 'package-lock.json']) {
    put(path, readFileSync(join(ROOT, path), 'utf8'));
  }
  put('.gitignore', 'node_modules\ncoverage\n');
  symlinkSync(join(ROOT, 'node_modules'), join(repo.dir, 'node_modules'));
  put('scripts/census-precheck.mjs', "console.log('fixture census passed');\n");
  put('src/run-task.ts', "import {writeFileSync} from 'node:fs'; writeFileSync('coverage/static-started','yes');\n");
  put('test/setup/tmp-hygiene.ts', 'export {};\n');
  put('test/oversized.test.ts', "import {test} from 'node:test'; test('capacity-only fixture',()=>{});\n");
  const suites = [...AUTHOR_WORKFLOW_CONTRACT_SUITES, 'test/oversized.test.ts'].sort();
  put('scripts/test-tier-manifest.json', JSON.stringify({ files: Object.fromEntries(suites.map(path => [path, 10_000_000])) }));
  repo.git('add', '.'); repo.git('commit', '-m', 'test: baseline workflow corpus');
  repo.git('remote', 'add', 'origin', repo.dir);
  repo.git('checkout', '-b', 'run-unfiled-workflow-contract-fixture');
  const commit = () => { repo.git('add', '.'); repo.git('commit', '-m', 'test: workflow contract mutation'); };
  const select = () => ({ fullRun: false, suites: suites.filter(path => existsSync(join(repo.dir, path))),
    reasons: ['verified over-capacity fixture'] });
  const run = () => main([], { root: repo.dir, select, host: () => ({ cores: 1, load1: 0, headroomBytes: 1024 ** 3 }) });
  const receipt = () => JSON.parse(readFileSync(join(repo.dir, 'coverage/preflight-author.json'), 'utf8'));
  return { ...repo, put, commit, run, receipt };
}

test('author workflow contracts follow the directory population and their own inputs without taxing unrelated changes', () => {
  assert.deepEqual(authorWorkflowContractInputs(['src/product.ts', 'docs/example.md', '.github/CODEOWNERS']), []);
  const inputs = [PROBE, '.github/workflows/deleted.yml', '.github/workflows/renamed.yaml', '.nvmrc',
    'scripts/preflight-author.mjs', 'scripts/lib/author-workflow-contract.mjs', ...AUTHOR_WORKFLOW_CONTRACT_SUITES];
  assert.deepEqual(authorWorkflowContractInputs(inputs), inputs);
  assert.deepEqual(AUTHOR_WORKFLOW_CONTRACT_SUITES,
    ['test/ci-cache-concurrency-and-job-timeouts.test.ts', 'test/workflow-job-timeouts.test.ts']);
});

test('author static workflow contracts catch a new directory member before capacity can skip R-50', (t) => {
  const f = fixture(t);
  for (const [broken, diagnostic] of [
    [validWorkflow.replace('with: {cache: npm}', 'with: {}'), /new-directory-member.yml.*cold installs/],
    [validWorkflow.replace('    timeout-minutes: 1\n', ''), /new-directory-member.yml.*no positive timeout/],
  ] as const) {
    f.put(PROBE, broken); f.commit();
    assert.equal(f.run(), 1);
    const refused = f.receipt();
    assert.equal(refused.verdict, 'refused');
    assert.deepEqual(refused.steps.map((step: { name: string }) => step.name), ['census-precheck', 'workflow-contract-precheck']);
    const step = refused.steps[1];
    assert.equal(step.ok, false); assert.ok(step.testSummary.fail > 0);
    assert.equal(step.judge.reported, step.judge.given);
    assert.deepEqual(step.judge.unreported, []);
    assert.match(readFileSync(join(f.dir, step.diagnostics.stdout), 'utf8'), diagnostic);
    assert.equal(refused.testSlot, undefined);
    assert.equal(refused.capacity, undefined);
    assert.equal(existsSync(join(f.dir, 'coverage/static-started')), false);
    assert.match(refused.affectedTestsNotRunReason, /workflow-contract-precheck did not succeed/);
  }
  // Positive control: identical priced selection now reaches capacity, which skips ALL suites.
  f.put(PROBE, validWorkflow); f.commit();
  assert.equal(f.run(), OVER_CAPACITY_EXIT);
  const over = f.receipt();
  assert.equal(over.verdict, 'over-capacity');
  assert.equal(over.steps[1].ok, true);
  assert.ok(over.steps[1].testSummary.tests > 0);
  assert.equal(over.steps[1].testSummary.pass, over.steps[1].testSummary.tests);
  assert.equal(over.steps[1].testSummary.fail, 0);
  assert.equal(over.steps[1].testSummary.skipped, 0);
  assert.equal(over.steps[1].judge.complete, true);
  assert.deepEqual(over.workflowContractPrecheck.suites, [...AUTHOR_WORKFLOW_CONTRACT_SUITES].sort());
  assert.equal(over.capacity.fits, false);
  assert.equal(existsSync(join(f.dir, 'coverage/static-started')), true);
  assert.equal(over.steps.some((step: { name: string }) => step.name.startsWith('affected-tests')), false);
});

test('author workflow precheck refuses a missing physical contract before heavy admission', (t) => {
  const f = fixture(t);
  f.put(PROBE, validWorkflow);
  unlinkSync(join(f.dir, AUTHOR_WORKFLOW_CONTRACT_SUITES[0])); f.commit();
  assert.equal(f.run(), 1);
  const refused = f.receipt();
  assert.equal(refused.verdict, 'refused');
  assert.match(refused.error, /ENOENT.*ci-cache-concurrency/);
  assert.equal(refused.testSlot, undefined);
  assert.deepEqual(refused.steps.map((step: { name: string }) => step.name), ['census-precheck']);
});

test('author workflow precheck refuses a zero-exit truncated contract instead of claiming a pass', (t) => {
  const f = fixture(t);
  f.put(PROBE, validWorkflow);
  f.put(AUTHOR_WORKFLOW_CONTRACT_SUITES[0], 'process.exit(0);\n'); f.commit();
  assert.equal(f.run(), 1);
  const refused = f.receipt();
  assert.equal(refused.steps[1].ok, false);
  assert.equal(refused.steps[1].judge.complete, false);
  assert.deepEqual(refused.steps[1].judge.unreported, [AUTHOR_WORKFLOW_CONTRACT_SUITES[0]]);
  assert.equal(refused.testSlot, undefined);
});
