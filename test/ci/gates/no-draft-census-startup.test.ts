import { REPO_ROOT as __testRepoRoot } from "#test/helpers/repo-root.js";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { makeTempDir } from "#src/lib/tmp.js";
// @ts-ignore the executable .mjs module has no declaration file.
import * as precheck from "#scripts/census-precheck.mjs";

function runStartupChild(repo: string, hook: string, args: string[], parentEnv: NodeJS.ProcessEnv = process.env) {
  const env = { ...parentEnv };
  delete env.NODE_TEST_CONTEXT;
  env.NODE_V8_COVERAGE = "";
  // Preserve the caller's heap/resource policy on every actual child.
  env.NODE_OPTIONS = parentEnv.NODE_OPTIONS;
  return spawnSync(process.execPath, ["--import", "tsx", "--import", hook, ...args], {
    cwd: repo, env, encoding: "utf8", timeout: 30_000,
  });
}

test("the fast no-draft census does not load the command dispatcher", () => {
  const repo = (__testRepoRoot + "/");
  const hook = join(makeTempDir("no-draft-census-startup"), "deny-dispatcher.mjs");
  writeFileSync(hook, `import { registerHooks } from 'node:module';
registerHooks({ load(url, context, nextLoad) {
  if (url.split('?')[0].endsWith('/src/run-task.ts')) throw new Error('census loaded dispatcher');
  return nextLoad(url, context);
} });\n`);
  const run = (args: string[]) => runStartupChild(repo, hook, args);
  // The same real hook must detect the actual dispatcher before its absence can be trusted.
  const forbidden = run(["--input-type=module", "-e", `await import(${JSON.stringify(pathToFileURL(join(repo, "src/run-task.ts")).href)});`]);
  assert.equal(forbidden.error, undefined);
  assert.notEqual(forbidden.status, 0);
  assert.match(forbidden.stderr, /census loaded dispatcher/);
  const census = run(["--import", "./test/setup/tmp-hygiene.ts", "--test", "--test-reporter=tap",
    "test/no-draft-pull-request-ever-sits-on-the-board.test.ts"]);
  assert.equal(census.error, undefined);
  assert.equal(census.status, 0, census.stdout + census.stderr);
  assert.match(census.stdout, /^# tests 3$/m);
  assert.match(census.stdout, /^# pass 3$/m);
  assert.match(census.stdout, /^# fail 0$/m);
  assert.match(census.stdout, /^# skipped 0$/m);
});

test("the no-draft startup census runs before push when its inputs change and propagates its failure", () => {
  const suite = "test/ci/gates/no-draft-census-startup.test.ts";
  for (const path of [suite, "test/no-draft-pull-request-ever-sits-on-the-board.test.ts",
    "scripts/no-draft-pull-request-census.mjs", "scripts/census-precheck.mjs", "test/helpers/git-repo.ts",
    "test/setup/tmp-hygiene.ts", "src/lib/tmp.ts", "package.json", "package-lock.json", ".nvmrc"]) {
    const runs: string[][] = [];
    const result = precheck.evaluateAdmittedCensusSuites({
      changed: [path], readHead: () => "", readBase: () => "", loadMembers: () => [],
      runSuites: (files: string[]) => { runs.push(files); return files.includes(suite) ? [suite] : []; },
    });
    assert.ok(runs.flat().includes(suite), path);
    assert.equal(runs.flat().filter((file) => file === suite).length, 1, path);
    assert.ok(result.violations.some((message: string) => message.startsWith(`census-suite: ${suite} fails`)), path);
    assert.equal(result.unmeasured, null, path);
  }
  assert.deepEqual(precheck.PRECHECK_PARITY[suite], { run: "census:no-draft-startup" });
});

test("unrelated edits start no no-draft startup child and an unreadable child stays unmeasured", () => {
  const suite = "test/ci/gates/no-draft-census-startup.test.ts";
  for (const path of ["docs/example.md", "src/lib/example.ts", "test/example.test.ts"]) {
    const result = precheck.evaluateAdmittedCensusSuites({
      changed: [path], readHead: () => "", readBase: () => "", loadMembers: () => [],
      runSuites: () => { throw new Error("unrelated edits must start no child"); },
    });
    assert.deepEqual(result, { violations: [], unmeasured: null }, path);
  }
  assert.deepEqual(precheck.evaluateAdmittedCensusSuites({
    changed: [suite], readHead: () => "", readBase: () => "", loadMembers: () => [],
    runSuites: () => { throw new Error("startup child timed out"); },
  }), { violations: [], unmeasured: "startup child timed out" });
});


test("the startup census child retains a tighter requested heap in the real Node runtime", () => {
  const hook = join(makeTempDir("no-draft-census-resource"), "noop-hook.mjs");
  writeFileSync(hook, "export {};\n");
  // Bound young space too: heap_size_limit includes three semi-spaces, not only old space.
  const requested = "--max-old-space-size=128 --max-semi-space-size=1";
  const child = runStartupChild(__testRepoRoot + "/", hook, ["--input-type=module", "-e",
    "import {getHeapStatistics} from 'node:v8'; process.stdout.write(JSON.stringify({limit:getHeapStatistics().heap_size_limit,options:process.env.NODE_OPTIONS}));"],
    { ...process.env, NODE_OPTIONS: requested });
  assert.equal(child.error, undefined);
  assert.equal(child.signal, null);
  assert.equal(child.status, 0, child.stdout + child.stderr);
  const actual = JSON.parse(child.stdout);
  assert.ok(Number.isSafeInteger(actual.limit) && actual.limit >= 128 * 1024 ** 2 && actual.limit <= 256 * 1024 ** 2,
    `the actual runtime must retain the tighter old-space request with native V8 overhead: ${actual.limit}`);
  assert.equal(actual.options, requested);
});
