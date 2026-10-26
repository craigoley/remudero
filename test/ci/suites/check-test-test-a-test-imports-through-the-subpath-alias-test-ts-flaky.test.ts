import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { gitRepo } from "#test/helpers/git-repo.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";
// @ts-ignore the executable .mjs module has no declaration file.
import { isTransientTestPath } from "#scripts/test-location-codemod.mjs";

test("W1-T10595: check:test:test/a-test-imports-through-the-subpath-alias.test.ts:flaky is prevented, not retried", (t) => {
  assert.equal(isTransientTestPath("test/.tmp-evid-lint-ab12/x.test.ts"), true);
  assert.equal(isTransientTestPath("test/proof-status-ab12/probe.ts"), true);
  assert.equal(isTransientTestPath("test/a-real-suite.test.ts"), false);
  assert.equal(isTransientTestPath("test/ci/suites/a.test.ts"), false);

  const repo = gitRepo({ scope: t });
  const put = (file: string, specifier: string) => {
    const path = join(repo.dir, file);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `import ${JSON.stringify(specifier)};\n`);
  };
  put("test/legacy.test.ts", "./legacy.js");
  repo.git("add", ".");
  repo.git("commit", "-qm", "seed alias count");
  repo.git("update-ref", "refs/remotes/origin/main", "HEAD");
  put("test/.tmp-evid-lint-ab12/x.test.ts", "./scratch.js");
  put("test/proof-status-ab12/probe.test.ts", "./scratch.js");
  put("test/ci/portable.test.ts", "#src/lib/ledger-path.js");

  const { NODE_TEST_CONTEXT: _context, ...childEnv } = process.env;
  const runRatchets = () => spawnSync(process.execPath, [
    "--import", import.meta.resolve("tsx"),
    "--import", join(REPO_ROOT, "test/setup/tmp-hygiene.ts"),
    "--test", "--test-reporter=tap",
    "--test-name-pattern", "W1-T9864: (location-relative test files|a new test file)",
    join(REPO_ROOT, "test/a-test-imports-through-the-subpath-alias.test.ts"),
  ], { cwd: repo.dir, env: childEnv, encoding: "utf8", timeout: 30_000 });

  const clean = runRatchets();
  assert.equal(clean.status, 0, clean.stdout + clean.stderr);
  assert.match(clean.stdout, /# pass 2\b/);
  assert.match(clean.stdout, /# fail 0\b/);
  assert.doesNotMatch(clean.stdout, /# SKIP/);

  // Both checks must still reject a real new violation beside the concurrent scratch files.
  put("test/ci/violation.test.ts", "./sibling.js");
  const violation = runRatchets();
  assert.equal(violation.status, 1, violation.stdout + violation.stderr);
  assert.match(violation.stdout, /# fail 2\b/);
  assert.match(violation.stdout, /test\/ci\/violation\.test\.ts/);
});
