// test/the-coverage-report-ignore-never-hides-a-test.test.ts
//
// LIVE 2026-10-30: #15434 (W1-T10186) spent 19 fix rounds as no-ops because its credited regression suite
// test/ci/coverage/ci-friction-remedy-8f6dbf092ca44510.test.ts was matched by the unanchored `coverage/`
// ignore rule: `git add -A` and `ls-files --others --exclude-standard` dropped it, and even an explicit
// `git add` of a tracked file there was refused. #14176's preservation tree hit the same rule (fixed by
// #14350 for that one reader). The coverage-report ignore must cover the generated root reports only.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { repoRoot } from "#src/lib/repo-location.js";

function ignored(path: string): boolean {
  // --no-index judges the pattern itself, so a tracked file is checked as an untracked one would be.
  const run = spawnSync("git", ["check-ignore", "--no-index", "--quiet", path], { cwd: repoRoot, encoding: "utf8" });
  assert.ok(run.status === 0 || run.status === 1, `git check-ignore failed: ${run.stderr}`);
  return run.status === 0;
}

test("the coverage-report ignore covers the root reports and never a test folder named coverage", () => {
  for (const generated of ["coverage/lcov.info", "coverage/raw/coverage-1.json", "coverage/preflight-author.json"]) {
    assert.equal(ignored(generated), true, `${generated} is a generated report and stays ignored`);
  }
  for (const source of ["test/ci/coverage/code-health-opportunities.test.ts", "test/ci/coverage/a-new-suite.test.ts",
    "src/lib/coverage/anything.ts"]) {
    assert.equal(ignored(source), false, `${source} is source and must never be ignored`);
  }
});
