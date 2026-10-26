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
  executeOpenWeightTool,
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

test("W1-T10421: check:test:test/the-open-weight-unit-test-check-loads-the-suite-guards.test.ts:flaky is prevented, not retried", async () => {
  const cwd = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}ow-plan-`));
  try {
    mkdirSync(join(cwd, "test"), { recursive: true });
    mkdirSync(join(cwd, "scripts"), { recursive: true });
    mkdirSync(join(cwd, "state"), { recursive: true });
    writeFileSync(join(cwd, "scripts", "diff-class.mjs"), "");
    writeFileSync(join(cwd, "test", "a.test.ts"), "");
    const good = { suites: ["test/a.test.ts"], fullRun: false, reasons: [], recentOnly: { floor: [] } };
    const ledger = { config: { root: cwd } as never, runId: "r", taskId: "t", clock: { now: () => Date.now(), iso: () => new Date().toISOString() } };

    // The real run_check dispatch, with the REAL selector whose child overruns once (cold start under load).
    const drive = async (execImpl: Parameters<typeof selectOpenWeightUnitTestSuitesOffLoop>[2]) => {
      const ran: string[][] = [];
      const result = await executeOpenWeightTool(
        "run_check", { check: "unit_test" }, cwd, {}, cwd,
        (input) => { ran.push([...input.argv]); return "ok"; }, ledger,
        (c, e) => selectOpenWeightUnitTestSuitesOffLoop(c, e, execImpl),
      ) as { ran?: boolean; refused?: string; exitCode?: number; suites?: number };
      return { ran, result };
    };

    let calls = 0;
    const recovered = await drive(async () => {
      calls += 1;
      if (calls === 1) throw Object.assign(new Error("timed out"), { killed: true });
      return { stdout: JSON.stringify(good), stderr: "" };
    });
    assert.equal(calls, 2, "the overrun child is retried once");
    assert.equal(recovered.result.refused, undefined, "the check does not refuse, so no fix round is spent");
    assert.equal(recovered.result.exitCode, 0);
    assert.equal(recovered.result.suites, 1);
    assert.equal(recovered.ran.length, 1);
    assert.ok(recovered.ran[0]!.includes("test/a.test.ts"));
    assert.ok(recovered.ran[0]!.includes(`--test-concurrency=${OPENWEIGHT_UNIT_TEST_CONCURRENCY}`));

    // Without the retry the same overrun would refuse; both overruns still refuse, never run whole-tree.
    const stuck = await drive(async () => { throw Object.assign(new Error("timed out"), { killed: true }); });
    assert.equal(stuck.ran.length, 0);
    assert.match(stuck.result.refused ?? "", /overran/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
