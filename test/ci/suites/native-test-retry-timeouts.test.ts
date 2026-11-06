import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
// @ts-ignore executable mjs module has no declaration file.
import { withTapReporter } from '#scripts/test-with-retry.mjs';
import { gitRepo } from '#test/helpers/git-repo.js';
import { REPO_ROOT } from '#test/helpers/repo-root.js';

const shellQuote = (value: string) => "'" + value.replace(/'/g, "'\\''") + "'";

test('native full-suite fallback bounds both the initial child and its failed-file retry', (t) => {
  const repo = gitRepo({ kind: 'native-retry-timeout', seedCommit: false });
  t.after(() => repo.cleanup());
  mkdirSync(join(repo.dir, 'test'));
  mkdirSync(join(repo.dir, 'scripts'));
  mkdirSync(join(repo.dir, 'bin'));
  const suite = 'test/recovers.test.mjs';
  const green = 'test/stays-green.test.mjs';
  const argvLog = join(repo.dir, 'argv.log');
  const node = join(repo.dir, 'bin/node');
  writeFileSync(join(repo.dir, 'package.json'), '{"type":"module"}\n');
  writeFileSync(join(repo.dir, '.gitignore'), 'argv.log\ninvocations\nstate/\n');
  writeFileSync(join(repo.dir, 'scripts/test-tier-manifest.json'), JSON.stringify({ files: { [suite]: 9000, [green]: 1 } }));
  writeFileSync(join(repo.dir, green), "import test from 'node:test'; test('always green',()=>{});\n");
  writeFileSync(join(repo.dir, suite), `import test from 'node:test'; import assert from 'node:assert/strict';
import {existsSync,readFileSync,writeFileSync} from 'node:fs';
const before=existsSync('invocations')?Number(readFileSync('invocations','utf8')):0;
writeFileSync('invocations',String(before+1));
test('recover on the one permitted retry',()=>assert.ok(before>0));\n`);
  // Refuse at the executable boundary BEFORE launching any untimed test child on the proof base.
  writeFileSync(node, `#!/bin/sh
printf '%s\\n' "$@" >> ${shellQuote(argvLog)}
case " $* " in *" --test-timeout=216000 "*) ;; *) echo 'missing derived test deadline' >&2; exit 3 ;; esac
exec ${shellQuote(process.execPath)} "$@"
`, { mode: 0o755 });
  repo.git('add', '.'); repo.git('commit', '-m', 'test: seed bounded native retry fixture');
  const env = { ...process.env, TEST_RETRY: '1', NODE_V8_COVERAGE: '' };
  delete env.NODE_TEST_CONTEXT;
  const args = withTapReporter(node, ['--test', suite, green]);
  assert.ok(args.includes('--test-reporter=tap'));
  const result = spawnSync(process.execPath, [join(REPO_ROOT, 'scripts/test-with-retry.mjs'), node, ...args],
    { cwd: repo.dir, env, encoding: 'utf8', timeout: 120000 });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(Number(readFileSync(join(repo.dir, 'invocations'), 'utf8')), 2);
  const actualArgs = readFileSync(argvLog, 'utf8').split('\n');
  assert.equal(actualArgs.filter(arg => arg === '--test-timeout=216000').length, 2);
  assert.equal(actualArgs.filter(arg => arg === suite).length, 2);
  assert.equal(actualArgs.filter(arg => arg === green).length, 1, 'the retry must stay scoped to the failing file');
  assert.match(result.stdout, /FLAKE-RETRY: first attempt failed/);
  assert.match(result.stdout, /# tests 1\b/);
  assert.match(result.stdout, /# fail 0\b/);
});
