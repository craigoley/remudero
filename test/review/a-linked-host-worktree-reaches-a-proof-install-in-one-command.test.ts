import assert from 'node:assert/strict';
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { materializeDependencySeed } from '#src/lib/dependency-seeds.js';
// @ts-expect-error -- the author preflight library has no declaration file.
import { authorDependencyProvenance } from '#scripts/lib/author-dependency-provenance.mjs';

const TOOLS = ['tsx', 'typescript', 'commitlint'] as const;
const LOCK = {
  name: 'linked-proof', version: '1.0.0', lockfileVersion: 3,
  packages: { '': { name: 'linked-proof', version: '1.0.0', devDependencies: Object.fromEntries(TOOLS.map(n => [n, '1.0.0'])) },
    ...Object.fromEntries(TOOLS.map(n => [`node_modules/${n}`, { version: '1.0.0' }])) },
};

function fixture(t: TestContext) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'rmd-proof-install-')));
  t.after(() => {
    const writable = (path: string): void => { const s = lstatSync(path); if (s.isSymbolicLink()) return; chmodSync(path, s.mode | 0o700); if (s.isDirectory()) for (const n of readdirSync(path)) writable(join(path, n)); };
    writable(root); rmSync(root, { recursive: true, force: true });
  });
  const store = join(root, 'seeds');
  const checkout = (name: string): string => {
    const path = join(root, name); mkdirSync(path);
    writeFileSync(join(path, 'package.json'), JSON.stringify({ name: 'linked-proof', version: '1.0.0', devDependencies: LOCK.packages[''].devDependencies }));
    writeFileSync(join(path, 'package-lock.json'), JSON.stringify(LOCK));
    return path;
  };
  // The npm seam alone is faked: it writes a tiny install whose .bin entries are relative links, as npm's are.
  const options = (proof: boolean) => ({ root: store, npmVersion: 'fixture', platform: 'linux' as const, proof, runInstall(stage: string) {
    const modules = join(stage, 'node_modules'); mkdirSync(join(modules, '.bin'), { recursive: true });
    for (const name of TOOLS) {
      mkdirSync(join(modules, name));
      writeFileSync(join(modules, name, 'package.json'), JSON.stringify({ name, version: '1.0.0' }));
      writeFileSync(join(modules, name, 'cli.mjs'), `// ${name}\n`);
    }
    for (const [bin, pkg] of [['tsx', 'tsx'], ['tsc', 'typescript'], ['commitlint', 'commitlint']]) symlinkSync(`../${pkg}/cli.mjs`, join(modules, '.bin', bin));
  } });
  return { root, store, checkout, options };
}

test('a refusal over a readonly-links worktree names the proof-install command, and a proof prime over its own link-only node_modules yields a private copy the precheck admits, while a foreign or real node_modules is left untouched', t => {
  const f = fixture(t), checkout = f.checkout('linked');
  const linked = materializeDependencySeed(checkout, f.options(false));
  assert.equal(linked.status, 'materialized');
  assert.equal(linked.status === 'materialized' && linked.method, 'readonly-links');
  assert.ok(lstatSync(join(checkout, 'node_modules/tsx')).isSymbolicLink());

  const refused = authorDependencyProvenance(checkout);
  assert.equal(refused.state, 'unavailable');
  assert.match(refused.reason, /escapes installed donor: tsx/);
  assert.ok(refused.reason.includes(`remudero-dependencies prime ${checkout} --proof`), refused.reason);

  const proof = materializeDependencySeed(checkout, f.options(true));
  assert.equal(proof.status, 'materialized');
  assert.equal(proof.status === 'materialized' && proof.method, 'private-copy');
  assert.equal(lstatSync(join(checkout, 'node_modules/tsx')).isSymbolicLink(), false);
  assert.equal(JSON.parse(readFileSync(join(checkout, 'node_modules/.rmd-dependency-seed.json'), 'utf8')).method, 'private-copy');
  assert.equal(authorDependencyProvenance(checkout).state, 'present');
  // A second proof prime now finds a private copy of its own and leaves it alone.
  assert.deepEqual(materializeDependencySeed(checkout, f.options(true)), { status: 'present' });
});

test('a foreign link in a readonly-links node_modules, or a real install, is not replaced by a proof prime', t => {
  const f = fixture(t), foreign = f.checkout('foreign'), real = f.checkout('real');
  assert.equal(materializeDependencySeed(foreign, f.options(false)).status, 'materialized');
  const outside = join(f.root, 'elsewhere'); mkdirSync(outside);
  rmSync(join(foreign, 'node_modules/tsx')); symlinkSync(outside, join(foreign, 'node_modules/tsx'), 'dir');
  try { materializeDependencySeed(foreign, f.options(true)); } catch (error) { assert.ok(error instanceof Error); }
  assert.equal(realpathSync(join(foreign, 'node_modules/tsx')), outside);
  assert.ok(lstatSync(join(foreign, 'node_modules/typescript')).isSymbolicLink());

  mkdirSync(join(real, 'node_modules'));
  for (const name of TOOLS) { mkdirSync(join(real, 'node_modules', name)); writeFileSync(join(real, 'node_modules', name, 'package.json'), JSON.stringify({ name, version: '1.0.0' })); }
  assert.deepEqual(materializeDependencySeed(real, f.options(true)), { status: 'present' });
  assert.equal(lstatSync(join(real, 'node_modules/tsx')).isDirectory(), true);
  assert.equal(readdirSync(join(real, 'node_modules')).includes('.rmd-dependency-seed.json'), false);
});
