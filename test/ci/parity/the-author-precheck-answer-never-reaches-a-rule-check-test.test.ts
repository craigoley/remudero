import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { AUTHOR_CENSUS_ANSWERED_ENV, FAST_GATE_STEPS, runPreflightFast } from "#src/lib/ci-parity.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";

const HEAD = execFileSync("git", ["rev-parse", "HEAD"], { cwd: REPO_ROOT, encoding: "utf8" }).trim();
const RULE_CHECKS_STEP = FAST_GATE_STEPS.find((step) => step.runner === "rule-checks");
const CENSUS_STEP = FAST_GATE_STEPS.find((step) => step.runner === "census-precheck");

function withAuthorAnswer<T>(answer: string, run: () => T): T {
  const before = process.env[AUTHOR_CENSUS_ANSWERED_ENV];
  process.env[AUTHOR_CENSUS_ANSWERED_ENV] = answer;
  try {
    return run();
  } finally {
    if (before === undefined) delete process.env[AUTHOR_CENSUS_ANSWERED_ENV];
    else process.env[AUTHOR_CENSUS_ANSWERED_ENV] = before;
  }
}

function ruleCheckFixture(t: { after(fn: () => void): void }): { root: string; resultPath: string } {
  const root = mkdtempSync(join(tmpdir(), "rmd-t11214-rule-check-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const put = (path: string, text: string) => {
    const target = join(root, path);
    mkdirSync(join(target, ".."), { recursive: true });
    writeFileSync(target, text);
  };

  put("package.json", JSON.stringify({ name: "remudero", scripts: {} }));
  put("node_modules/tsx/package.json", JSON.stringify({ name: "tsx", type: "module", exports: "./index.js" }));
  put("node_modules/tsx/index.js", "export {};\n");
  put(
    "scripts/list-rule-suites.mjs",
    [
      'import { writeFileSync } from "node:fs";',
      `writeFileSync(process.env.RMD_AUTHOR_CENSUS_RESULT, process.env.${AUTHOR_CENSUS_ANSWERED_ENV} ?? "unset");`,
      "",
    ].join("\n"),
  );

  return { root, resultPath: join(root, "author-answer.txt") };
}

test("test/ci/parity/the-author-precheck-answer-never-reaches-a-rule-check-test.test.ts: a rule-check child cannot reuse the author's census answer", (t) => {
  assert.ok(RULE_CHECKS_STEP, "the fast gate has a rule-checks runner");
  const fixture = ruleCheckFixture(t);
  const previousResultPath = process.env.RMD_AUTHOR_CENSUS_RESULT;
  process.env.RMD_AUTHOR_CENSUS_RESULT = fixture.resultPath;

  try {
    const answer = `${HEAD}:ok`;
    const result = withAuthorAnswer(answer, () => {
      const outcome = runPreflightFast(fixture.root, { steps: [RULE_CHECKS_STEP!] });
      assert.equal(process.env[AUTHOR_CENSUS_ANSWERED_ENV], answer, "the parent restores its author answer after the child starts");
      return outcome;
    });

    assert.equal(result.ok, true, result.steps.map((step) => step.detail).join("\n"));
    assert.equal(readFileSync(fixture.resultPath, "utf8"), "unset", "rule-check child inherited the author's census answer");
  } finally {
    if (previousResultPath === undefined) delete process.env.RMD_AUTHOR_CENSUS_RESULT;
    else process.env.RMD_AUTHOR_CENSUS_RESULT = previousResultPath;
  }
});

test("test/ci/parity/the-author-precheck-answer-never-reaches-a-rule-check-test.test.ts: census-precheck still reuses its matching author answer", () => {
  assert.ok(CENSUS_STEP, "the fast gate has a census-precheck runner");
  const calls: string[][] = [];
  const result = withAuthorAnswer(`${HEAD}:ok`, () =>
    runPreflightFast(REPO_ROOT, {
      steps: [CENSUS_STEP!],
      spawn: (_file, args) => {
        calls.push(args);
        return { status: 0, stdout: "unexpected census run", stderr: "" };
      },
    }),
  );

  assert.equal(result.ok, true, result.steps.map((step) => step.detail).join("\n"));
  assert.match(result.steps[0]!.detail, new RegExp(`answered by the author preflight's census-precheck step at ${HEAD} \\(ok\\); not run again`));
  assert.equal(calls.length, 0, "the census step stopped reusing the matching author answer");
});
