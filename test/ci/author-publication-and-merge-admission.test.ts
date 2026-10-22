import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { gitRepo } from '#test/helpers/git-repo.js';
// @ts-expect-error the production author executable is plain JavaScript.
import { main } from '#scripts/preflight-author.mjs';

function fixture(t: { after: (cleanup: () => void) => void }, conflict = false) {
  const repo = gitRepo({ kind: 'author-publication-merge-admission', seedCommit: false });
  t.after(() => repo.cleanup());
  for (const name of ['src', 'test']) mkdirSync(join(repo.dir, name));
  writeFileSync(join(repo.dir, '.nvmrc'), process.versions.node + '\n');
  writeFileSync(join(repo.dir, '.gitignore'), 'coverage\n');
  writeFileSync(join(repo.dir, 'src/leaf.ts'), 'export const leaf = 1;\n');
  writeFileSync(join(repo.dir, 'test/leaf.test.ts'), '// Physical dry-run selection target; never executed.\n');
  repo.git('add', '.'); repo.git('commit', '-m', 'test: admission fixture baseline');
  repo.addRemote('origin', repo.dir);
  repo.git('checkout', '-b', 'codex/admission-fixture');
  writeFileSync(join(repo.dir, 'src/leaf.ts'), 'export const leaf = 2;\n');
  repo.git('add', '.'); repo.git('commit', '-m', 'fix: admission fixture leaf');
  const head = repo.git('rev-parse', 'HEAD');
  if (conflict) {
    repo.git('checkout', 'main');
    writeFileSync(join(repo.dir, 'src/leaf.ts'), 'export const leaf = 3;\n');
    repo.git('add', '.'); repo.git('commit', '-m', 'fix: conflicting fixture main leaf');
    repo.git('checkout', 'codex/admission-fixture');
  }
  return { ...repo, head, base: repo.git('rev-parse', 'main') };
}

function observe(f: ReturnType<typeof fixture>, args: string[]) {
  let selections = 0;
  const merges: string[][] = [];
  const observedSpawn = ((file: string, argv: string[], options: Parameters<typeof spawnSync>[2]) => {
    assert.equal(file, 'git', 'these dry-run admission cases must not start static, native or package children');
    if (argv[0] === 'merge-tree') merges.push([...argv]);
    return spawnSync(file, argv, options);
  }) as typeof spawnSync;
  const exit = main(['--dry-run', ...args], { root: f.dir, spawn: observedSpawn, select: () => {
    selections += 1;
    return { fullRun: false, suites: ['test/leaf.test.ts'], reasons: ['physical admission fixture'] };
  } });
  const receipt = JSON.parse(readFileSync(join(f.dir, 'coverage/preflight-author.json'), 'utf8'));
  assert.deepEqual(receipt.steps, []);
  assert.equal(receipt.testSlot, undefined);
  assert.equal(receipt.dependencyProvenance, undefined);
  assert.equal(receipt.headSha, f.head);
  assert.equal(receipt.baseSha, f.base);
  return { exit, receipt, selections, merges };
}

test('publication identity and fetched-base compatibility both refuse before author selection', t => {
  const destination = 'run-unfiled-1792200000000';
  // Real conflicting Git history cannot hide an earlier publication identity refusal.
  const conflicting = fixture(t, true);
  const identity = observe(conflicting, ['--head-ref', 'codex/invalid-publication']);
  assert.equal(identity.exit, 1);
  assert.equal(identity.receipt.publicationIdentity.state, 'refused');
  assert.equal(identity.receipt.mergeCompatibility, undefined);
  assert.equal(identity.selections, 0);
  assert.deepEqual(identity.merges, []);
  const wrongHead = observe(conflicting, ['--head-ref', destination, '--head-sha', conflicting.base]);
  assert.equal(wrongHead.exit, 1);
  assert.equal(wrongHead.receipt.publicationIdentity.state, 'refused');
  assert.match(wrongHead.receipt.error, /is not the committed author HEAD/);
  assert.equal(wrongHead.receipt.mergeCompatibility, undefined);
  assert.equal(wrongHead.selections, 0);
  assert.deepEqual(wrongHead.merges, []);

  const incompatible = observe(conflicting, ['--head-ref', destination, '--head-sha', conflicting.head]);
  assert.equal(incompatible.exit, 1);
  assert.equal(incompatible.receipt.publicationIdentity.state, 'passed');
  assert.equal(incompatible.receipt.mergeCompatibility.state, 'conflict');
  assert.equal(incompatible.receipt.mergeCompatibility.head, conflicting.head);
  assert.equal(incompatible.receipt.mergeCompatibility.base, conflicting.base);
  assert.equal(incompatible.selections, 0);
  assert.deepEqual(incompatible.merges, [['merge-tree', '--write-tree', conflicting.base, conflicting.head]]);

  const compatible = fixture(t);
  const admitted = observe(compatible, ['--head-ref', destination, '--head-sha', compatible.head]);
  assert.equal(admitted.exit, 0);
  assert.equal(admitted.receipt.publicationIdentity.state, 'passed');
  assert.equal(admitted.receipt.mergeCompatibility.state, 'compatible');
  assert.match(admitted.receipt.mergeCompatibility.tree, /^[a-f0-9]{40}$/);
  assert.equal(admitted.selections, 1);
  assert.deepEqual(admitted.merges, [['merge-tree', '--write-tree', compatible.base, compatible.head]]);
  assert.equal(admitted.receipt.verdict, 'not-run', 'dry-run admission never certifies an author run');
});
