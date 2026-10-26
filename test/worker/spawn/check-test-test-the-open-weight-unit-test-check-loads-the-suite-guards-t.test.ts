/**
 * The open-weight unit_test guard suite's third case drives a real selector child (git reads plus
 * census listings), which is the load-sensitive part. This pins the same argv contract through the
 * pure planner, so a regression there reddens deterministically, with no child process.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  OPENWEIGHT_UNIT_TEST_CONCURRENCY,
  OPENWEIGHT_UNIT_TEST_NICE,
  TEST_PROCESS_GUARD_IMPORTS,
  openWeightUnitTestPlan,
  selectOpenWeightUnitTestSuitesOffLoop,
} from "#src/lib/worker-provider.js";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";

test("W1-T10421: selector child overrun under load is retried once, then refuses (never empty)", async () => {
  const good = { suites: ["test/a.test.ts"], fullRun: false, reasons: [], recentOnly: { floor: [] } };
  const killed = () => Object.assign(new Error("timed out"), { killed: true });
  let calls = 0;
  const recovered = await selectOpenWeightUnitTestSuitesOffLoop("/x", {}, async () => {
    calls += 1;
    if (calls === 1) throw killed();
    return { stdout: JSON.stringify(good), stderr: "" };
  });
  assert.equal(calls, 2);
  assert.deepEqual(recovered.suites, ["test/a.test.ts"]);
  assert.equal(recovered.fullRun, false);

  let stuck = 0;
  const refused = await selectOpenWeightUnitTestSuitesOffLoop("/x", {}, async () => { stuck += 1; throw killed(); });
  assert.equal(stuck, 2, "exactly one retry");
  assert.equal(refused.fullRun, true);

  let broken = 0;
  const failed = await selectOpenWeightUnitTestSuitesOffLoop("/x", {}, async () => { broken += 1; throw new Error("boom"); });
  assert.equal(broken, 1, "a non-timeout failure is not retried");
  assert.equal(failed.fullRun, true);
});

test("W1-T10421: check:test:test/the-open-weight-unit-test-check-loads-the-suite-guards.test.ts:flaky is prevented, not retried", () => {
  const cwd = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}ow-plan-`));
  try {
    mkdirSync(join(cwd, "test"), { recursive: true });
    mkdirSync(join(cwd, "scripts"), { recursive: true });
    writeFileSync(join(cwd, "scripts", "diff-class.mjs"), "");
    writeFileSync(join(cwd, "test", "a.test.ts"), "");
    const base = ["node", "--import", "tsx", ...TEST_PROCESS_GUARD_IMPORTS.slice(2), "--test", "--test-reporter=tap"];
    const plan = openWeightUnitTestPlan(
      { suites: ["test/a.test.ts", "test/missing.test.ts"], fullRun: false, reasons: [], recentOnly: { floor: [] } } as never,
      base, cwd,
    );
    assert.equal(plan.kind, "run");
    if (plan.kind !== "run") return;
    assert.deepEqual(plan.suites, ["test/a.test.ts"]);
    assert.deepEqual(plan.argv, [
      ...OPENWEIGHT_UNIT_TEST_NICE, ...base, `--test-concurrency=${OPENWEIGHT_UNIT_TEST_CONCURRENCY}`, "test/a.test.ts",
    ]);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
