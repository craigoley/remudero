import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { gitRepo } from './git-repo.js';

export function makeRuntimeFixture(fail = false) {
  const f = gitRepo({ kind: 'native-runtime', seedCommit: false });
  for (const dir of ['scripts', 'test/setup', 'src']) mkdirSync(join(f.dir, dir), { recursive: true });
  writeFileSync(join(f.dir, '.nvmrc'), process.versions.node + '\n');
  writeFileSync(join(f.dir, '.gitignore'), 'coverage\nnode_modules\n');
  writeFileSync(join(f.dir, 'package-lock.json'), '{}\n');
  symlinkSync(join(process.cwd(), 'node_modules'), join(f.dir, 'node_modules'));
  writeFileSync(join(f.dir, 'scripts/test-duration-reporter.mjs'), readFileSync(join(process.cwd(), 'scripts/test-duration-reporter.mjs')));
  writeFileSync(join(f.dir, 'scripts/test-tier-manifest.json'), JSON.stringify({ version: 1, thresholdMs: 10_000,
    files: { 'test/a.test.ts': 1500, 'test/b.test.ts': 1500 } }));
  writeFileSync(join(f.dir, 'scripts/diff-class.mjs'), '// No census readers in this fixture.\n');
  writeFileSync(join(f.dir, 'scripts/census-precheck.mjs'), "console.log('fixture census passed');\n");
  writeFileSync(join(f.dir, 'test/setup/tmp-hygiene.ts'), 'export {};\n');
  writeFileSync(join(f.dir, 'src/run-task.ts'), "import{writeFileSync}from'node:fs';writeFileSync('coverage/static-started','yes');\n");
  for (const name of ['a', 'b']) writeFileSync(join(f.dir, `test/${name}.test.ts`),
    `import{test}from'node:test';test('native ${name}',()=>{${fail && name === 'b' ? "throw Error('fixture failure')" : ''}});\n`);
  f.git('add', '.'); f.git('commit', '-m', 'test: native runtime baseline');
  f.git('remote', 'add', 'origin', f.dir);
  f.git('checkout', '-b', 'run-unfiled-native-runtime');
  writeFileSync(join(f.dir, 'src/leaf.ts'), 'export const changed = 2;\n');
  f.git('add', '.'); f.git('commit', '-m', 'test: native runtime head');
  return f;
}
