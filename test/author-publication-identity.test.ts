import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { gitRepo } from './helpers/git-repo.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
type Identity = {
  state: 'passed' | 'refused' | 'unknown-target';
  headRef: string | null;
  targetRef?: string;
  headSha: string;
  baseSha: string;
  message: string;
};
type IdentityInput = { headRef?: string; headSha: string; baseSha: string; publicationSha?: string };
const author = await import(pathToFileURL(join(ROOT, 'scripts/preflight-author.mjs')).href) as {
  authorPublicationIdentity: (input: IdentityInput, git: (args: string[]) => string) => Identity;
  main: (argv: string[], deps: { root: string; select: () => unknown; spawn?: typeof spawnSync }) => number;
};

// Real, tiny Git fixtures only. Every main() call below is a dry run: no dependency install,
// census, native tool, lease or test child. origin is this disposable fixture's own local path.
function fixture(t: { after: (cleanup: () => void) => void }, change: 'code' | 'docs' | 'rename' = 'code') {
  const repo = gitRepo({ kind: 'author-publication-identity', seedCommit: false });
  t.after(() => repo.cleanup());
  for (const path of ['src', 'test', 'docs']) mkdirSync(join(repo.dir, path));
  writeFileSync(join(repo.dir, '.nvmrc'), process.versions.node + '\n');
  writeFileSync(join(repo.dir, '.gitignore'), 'coverage\n');
  writeFileSync(join(repo.dir, 'src/leaf.ts'), 'export const leaf = 1;\n');
  writeFileSync(join(repo.dir, 'test/leaf.test.ts'), '// A physical selection target; never executed.\n');
  repo.git('add', '.');
  repo.git('commit', '-m', 'test: publication fixture baseline');
  const baseSha = repo.git('rev-parse', 'HEAD');
  repo.addRemote('origin', repo.dir);
  repo.git('checkout', '-b', 'codex/publication-fixture');
  if (change === 'rename') repo.git('mv', 'src/leaf.ts', 'docs/leaf.md');
  else writeFileSync(join(repo.dir, change === 'docs' ? 'docs/publication.md' : 'src/leaf.ts'),
    change === 'docs' ? 'Publication fixture documentation.\n' : 'export const leaf = 2;\n');
  repo.git('add', '.');
  repo.git('commit', '-m', 'fix: publication fixture change');
  return { ...repo, baseSha, headSha: repo.git('rev-parse', 'HEAD'),
    receipt: () => JSON.parse(readFileSync(join(repo.dir, 'coverage/preflight-author.json'), 'utf8')) };
}

function dryRun(f: ReturnType<typeof fixture>, args: string[] = [], spawn?: typeof spawnSync) {
  let selections = 0;
  const status = author.main(['--dry-run', ...args], { root: f.dir, spawn, select: () => {
    selections += 1;
    return { fullRun: false, suites: ['test/leaf.test.ts'], reasons: ['publication identity fixture'] };
  } });
  const receipt = f.receipt();
  assert.deepEqual(receipt.steps, [], 'no validation child should run, even in the positive control');
  assert.equal(receipt.testSlot, undefined);
  assert.equal(receipt.dependencyProvenance, undefined);
  return { status, selections, receipt, identity: receipt.publicationIdentity as Identity };
}

test('author publication identity admits the actual run destination from a local codex branch', (t) => {
  const f = fixture(t);
  const target = 'run-unfiled-1792152000000';
  const result = dryRun(f, ['--head-ref', `refs/heads/${target}`, '--head-sha', f.headSha]);
  assert.equal(result.status, 0);
  assert.equal(result.selections, 1);
  assert.equal(result.receipt.verdict, 'not-run');
  assert.deepEqual(result.identity, { state: 'passed', headRef: target, targetRef: `refs/heads/${target}`,
    headSha: f.headSha, baseSha: f.baseSha, message: `identified via its run-shaped head ref (${target})` });
  assert.equal(f.git('branch', '--show-current'), 'codex/publication-fixture');
  assert.doesNotMatch(f.git('log', '-1', '--format=%B'), /^Remudero-Task:/m);
});

test('author publication identity refuses a code destination before selection even from a conforming local branch', (t) => {
  const f = fixture(t);
  f.git('checkout', '-b', 'run-unfiled-1792152000000');
  const result = dryRun(f, ['--head-ref', 'codex/publication-destination']);
  assert.equal(result.status, 1);
  assert.equal(result.selections, 0, 'identity must refuse before even selecting suites');
  assert.equal(result.receipt.verdict, 'refused');
  assert.equal(result.identity.state, 'refused');
  assert.equal(result.identity.headRef, 'codex/publication-destination');
  assert.equal(result.identity.headSha, f.headSha);
  assert.match(result.receipt.error, /matches neither conforming form/);
  assert.match(result.receipt.affectedTestsNotRunReason, /publication identity refused/);
});

test('author publication identity leaves an unknown target explicit and allows ordinary author selection', (t) => {
  const f = fixture(t);
  // Even a local run branch cannot fabricate a known publication target.
  for (const branch of ['codex/publication-fixture', 'run-unfiled-1792152000000']) {
    if (branch.startsWith('run-')) f.git('checkout', '-b', branch);
    const result = dryRun(f);
    assert.equal(result.status, 0);
    assert.equal(result.selections, 1);
    assert.equal(result.receipt.verdict, 'not-run');
    assert.equal(result.identity.state, 'unknown-target');
    assert.equal(result.identity.headRef, null);
    assert.equal(result.identity.targetRef, undefined);
    assert.match(result.identity.message, /identity NOT verified/);
  }
});

test('author publication identity refuses a different committed publication head', (t) => {
  const f = fixture(t);
  const result = dryRun(f, ['--head-ref', 'run-unfiled-1792152000000', '--head-sha', f.baseSha]);
  assert.equal(result.status, 1);
  assert.equal(result.selections, 0);
  assert.equal(result.identity.state, 'refused');
  assert.match(result.receipt.error, /is not the committed author HEAD/);
  assert.equal(f.git('rev-parse', 'HEAD'), f.headSha);
});

test('author publication identity preserves the existing non-code exemption and refuses code renamed into docs', (t) => {
  const docs = dryRun(fixture(t, 'docs'), ['--head-ref', 'codex/docs-destination']);
  assert.equal(docs.status, 0);
  assert.equal(docs.identity.state, 'passed');
  assert.match(docs.identity.message, /non-code head/);
  const renamed = dryRun(fixture(t, 'rename'), ['--head-ref', 'codex/docs-destination']);
  assert.equal(renamed.status, 1);
  assert.equal(renamed.selections, 0);
  assert.equal(renamed.identity.state, 'refused', 'the deleted source side must be counted');
});

test('author publication identity reads only the exact head first-parent author message after a main merge', (t) => {
  const f = fixture(t);
  // Trailer is fixture-only: an unrelated main commit must never identify this publication head.
  f.git('checkout', 'main');
  writeFileSync(join(f.dir, 'docs/main.md'), 'Unrelated main change.\n');
  f.git('add', '.');
  f.git('commit', '-m', 'test: unrelated main identity\n\nRemudero-Task: PR-1');
  f.git('checkout', 'codex/publication-fixture');
  f.git('merge', '--no-ff', 'main', '-m', 'Merge main into publication fixture');
  const headSha = f.git('rev-parse', 'HEAD');
  const calls: string[][] = [];
  const identity = author.authorPublicationIdentity({ headRef: 'codex/publication-destination',
    headSha, baseSha: f.git('rev-parse', 'main') }, (args) => {
    calls.push(args);
    return f.git(...args);
  });
  assert.equal(identity.state, 'refused');
  assert.ok(calls.some(args => JSON.stringify(args) === JSON.stringify(
    ['log', '-1', '--first-parent', '--no-merges', '--format=%B', headSha])));
  assert.ok(calls.some(args => args[0] === 'diff' && args.includes('--no-renames') && args.at(-1)?.endsWith(`...${headSha}`)));
});

test('author publication identity rejects missing, symbolic, non-branch and malformed destinations', (t) => {
  const f = fixture(t);
  for (const target of ['', 'HEAD', 'refs/tags/run-unfiled-1792152000000', 'refs/remotes/origin/main', 'run-unfiled-1792152000000..']) {
    const result = dryRun(f, ['--head-ref', target]);
    assert.equal(result.status, 1, target);
    assert.equal(result.selections, 0, target);
    assert.equal(result.identity.state, 'refused', target);
  }
});

test('author publication identity refuses unreadable message and diff evidence instead of claiming pass', (t) => {
  const f = fixture(t);
  for (const command of ['log', 'diff']) {
    const spawn = ((file: string, args: string[], options: Parameters<typeof spawnSync>[2]) =>
      file === 'git' && args[0] === command
        ? { status: 128, stdout: '', stderr: `fixture unreadable ${command}`, signal: null, pid: 0, output: [] }
        : spawnSync(file, args, options)) as typeof spawnSync;
    const result = dryRun(f, ['--head-ref', 'run-unfiled-1792152000000'], spawn);
    assert.equal(result.status, 1);
    assert.equal(result.selections, 0);
    assert.equal(result.identity.state, 'refused');
    assert.match(result.receipt.error, /publication identity could not be measured/);
    assert.match(result.receipt.error, new RegExp(`fixture unreadable ${command}`));
  }
  const empty = author.authorPublicationIdentity({ headRef: 'run-unfiled-1792152000000',
    headSha: f.headSha, baseSha: f.baseSha }, (args) => args[0] === 'log' ? '' : f.git(...args));
  assert.equal(empty.state, 'refused');
  assert.match(empty.message, /cannot read the publication head author message/);
});
