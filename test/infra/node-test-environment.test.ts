import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, writeFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { REPO_ROOT } from '#test/helpers/repo-root.js';
const implementation = pathToFileURL(join(REPO_ROOT, 'src/lib/node-test-environment.ts'));
const nativeEnvironment = existsSync(fileURLToPath(implementation)) ? await import(implementation.href) : undefined;
function requireNativeEnvironment(): typeof import('#src/lib/node-test-environment.js') {
  assert.ok(nativeEnvironment, 'this committed tree must provide native heap-preserving context isolation');
  return nativeEnvironment;
}

function withEnvironment(values: NodeJS.ProcessEnv, run: () => void) {
  const saved = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]]));
  try {
    for (const [key, value] of Object.entries(values)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    run();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
}

test('native context isolation retains exact declared heap spelling order and smaller targets', () => {
  const { resourceOnlyNodeOptions } = requireNativeEnvironment();
  for (const value of [undefined, '', '  ', '--max-old-space-size=1024',
    '--max_old_space_size 384 --max-semi-space-size=8', '--max-old-space-size=128 --max-old-space-size=96'])
    assert.equal(resourceOnlyNodeOptions(value), value);
});

test('native context isolation strips nonresource test startup options as before', () => {
  const { withoutNodeTestContext } = requireNativeEnvironment();
  for (const value of [undefined, '--trace-warnings', '--require "./fixture hook.js"']) {
    withEnvironment({ NODE_TEST_CONTEXT: 'parent-native-fixture', NODE_OPTIONS: value }, () => {
      withoutNodeTestContext(() => {
        assert.equal(process.env.NODE_TEST_CONTEXT, undefined);
        assert.equal(process.env.NODE_OPTIONS, undefined);
      });
      assert.equal(process.env.NODE_TEST_CONTEXT, 'parent-native-fixture');
      assert.equal(process.env.NODE_OPTIONS, value);
    });
  }
});

test('mixed or unmodelled heap input refuses before work instead of dropping the bound', () => {
  const { withoutNodeTestContext } = requireNativeEnvironment();
  for (const value of ['--require ./hook.js --max-old-space-size=128', '--max-old-space-size=0', '--max-old-space-size',
    '--max-old-space-size=9007199254740992', '--max-old-space-size-percentage=50', '--max-heap-size=128']) {
    withEnvironment({ NODE_TEST_CONTEXT: 'parent-native-fixture', NODE_OPTIONS: value }, () => {
      let called = false;
      assert.throws(() => withoutNodeTestContext(() => { called = true; }), /mixed or unmodelled heap/);
      assert.equal(called, false);
      assert.equal(process.env.NODE_TEST_CONTEXT, 'parent-native-fixture');
      assert.equal(process.env.NODE_OPTIONS, value);
    });
  }
});

test('native context isolation restores the caller after a thrown real callback', () => {
  const { withoutNodeTestContext } = requireNativeEnvironment();
  withEnvironment({ NODE_TEST_CONTEXT: 'parent-native-fixture', NODE_OPTIONS: '--max-old-space-size=128' }, () => {
    assert.throws(() => withoutNodeTestContext(() => {
      assert.equal(process.env.NODE_OPTIONS, '--max-old-space-size=128');
      assert.equal(process.env.NODE_TEST_CONTEXT, undefined);
      throw new Error('actual callback failure');
    }), /actual callback failure/);
    assert.equal(process.env.NODE_TEST_CONTEXT, 'parent-native-fixture');
    assert.equal(process.env.NODE_OPTIONS, '--max-old-space-size=128');
  });
});

test('a real nested native test executes assertions under its retained heap bound', () => {
  const { withoutNodeTestContext } = requireNativeEnvironment();
  const root = mkdtempSync(join(tmpdir(), 'rmd-node-context-heap-'));
  try {
    const file = join(root, 'bounded.test.mjs');
    writeFileSync(file, `import {test} from 'node:test';import assert from 'node:assert/strict';
import {getHeapStatistics} from 'node:v8';test('real bounded child',()=>{
 assert.equal(process.env.NODE_OPTIONS,'--max-old-space-size=128 --max-semi-space-size=4');
 assert.ok(process.env.NODE_TEST_CONTEXT);const heap = getHeapStatistics().heap_size_limit;
 assert.ok(heap<=160*1024*1024, 'real child heap limit='+heap);
});\n`);
    assert.equal(statSync(file).isFile(), true);
    withEnvironment({ NODE_TEST_CONTEXT: 'parent-native-fixture', NODE_OPTIONS: '--max-old-space-size=128 --max-semi-space-size=4' }, () => {
      const child = withoutNodeTestContext(() => spawnSync(process.execPath,
        ['--test', '--test-concurrency=1', '--test-reporter=tap', file],
        { env: process.env, encoding: 'utf8', timeout: 10000, maxBuffer: 1024 * 1024 }));
      assert.equal(child.status, 0, child.stdout + child.stderr);
      assert.equal(child.signal, null);
      assert.match(child.stdout, /^ok 1 - real bounded child$/m);
      assert.match(child.stdout, /^# tests 1$/m);
      assert.match(child.stdout, /^# fail 0$/m);
      assert.equal(process.env.NODE_TEST_CONTEXT, 'parent-native-fixture');
      assert.equal(process.env.NODE_OPTIONS, '--max-old-space-size=128 --max-semi-space-size=4');
    });
  } finally { rmSync(root, { recursive: true, force: true }); }
});
