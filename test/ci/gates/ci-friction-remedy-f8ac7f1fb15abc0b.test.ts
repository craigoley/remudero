// @census-reads: scripts/ src/ test/a-census-this-branch-grows-is-refused-before-the-push.test.ts
// @census-reads: test/helpers/ test/setup/ package.json package-lock.json
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
// @ts-ignore the executable .mjs module has no declaration file.
import { evaluateAdmittedCensusSuites } from "#scripts/census-precheck.mjs";
import { REPO_ROOT } from "#test/helpers/repo-root.js";

const SMOKE = "test/ci/gates/ci-friction-remedy-f8ac7f1fb15abc0b.test.ts";
const FIXTURE = "test/a-census-this-branch-grows-is-refused-before-the-push.test.ts";
const PRECHECK = "scripts/census-precheck.mjs";

test("W1-T10445: check:test:test/a-census-this-branch-grows-is-refused-before-the-push.test.ts is prevented, not retried", () => {
  const dependency = "scripts/clock-signature-ratchet.mjs";
  const importLine = (specifier: string) => `import ${JSON.stringify(specifier)};`;
  const precheckSource = importLine("./clock-signature-ratchet.mjs");
  const evaluate = (changed: string, fail: boolean, smokeExists = true) => {
    const base = new Map([[PRECHECK, precheckSource]]);
    if (smokeExists) base.set(SMOKE, "");
    const readBase = (path: string) => base.get(path) ?? null;
    return evaluateAdmittedCensusSuites({
      changed: [changed],
      loadMembers: () => [],
      readBase,
      readHead: (path: string) => path === dependency ? importLine("./new-helper.mjs") : readBase(path),
      runSuites: (files: string[]) => fail ? files.filter(file => file === SMOKE) : [],
    });
  };
  assert.deepEqual(evaluate("package.json", true, false), { violations: [], unmeasured: null });
  for (const path of [PRECHECK, FIXTURE, dependency, "package.json"]) {
    const result = evaluate(path, true);
    assert.equal(result.unmeasured, null);
    assert.ok(result.violations.some((line: string) => line.startsWith(`census-suite: ${SMOKE} fails`)), path);
    assert.deepEqual(evaluate(path, false).violations, []);
  }
  assert.deepEqual(evaluate("src/unrelated.ts", true).violations, []);

  const result = spawnSync(process.execPath, [
    "--test", "--test-reporter=tap", "--import", "tsx", "--import", "./test/setup/tmp-hygiene.ts",
    "--test-name-pattern", "census precheck: a (branch that grows a clock row|clean change passes)",
    FIXTURE,
  ], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    env: { ...process.env, NODE_TEST_CONTEXT: undefined, NODE_V8_COVERAGE: "", RMD_CENSUS_SNAPSHOT: "" },
  });
  assert.ifError(result.error);
  const output = result.stdout + result.stderr;
  assert.equal(result.status, 0, output);
  assert.match(output, /^# tests 2$/m);
  assert.match(output, /^# pass 2$/m);
});
