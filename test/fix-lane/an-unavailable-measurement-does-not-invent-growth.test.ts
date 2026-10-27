import assert from "node:assert/strict";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { checkFixCensusSnapshot } from "#src/run-task.js";

const passed = { status: 0, signal: null, stdout: "TAP version 13\n1..1\n# tests 1\n# pass 1\n# fail 0\n", stderr: "" };

test("a signalled census child remains a refusal without inventing count growth", () => {
  const run = (results: unknown[]) => {
    let calls = 0;
    const events: Array<{ step: string; data: unknown }> = [];
    const outcome = checkFixCensusSnapshot("/unused-injected-root", "/unused-snapshot", (step, data) => events.push({ step, data }),
      ((file: string, args: string[], options: Parameters<typeof spawnSync>[2]) => args.includes("--snapshot-budget")
        ? spawnSync(file, args, options) : results[calls++] ?? passed) as unknown as Parameters<typeof checkFixCensusSnapshot>[3]);
    return { outcome: outcome!, calls, events };
  };
  assert.equal(run([passed, passed]).outcome.refusal, undefined);
  const partial = run([{ ...passed, status: 2, stdout: "census suites NOT MEASURED (time bound)" }, passed]);
  assert.equal(partial.outcome.refusal, undefined);
  assert.match(partial.outcome.unmeasured!, /time bound/);
  for (const phase of [0, 1]) {
    for (const failure of [
      { ...passed, status: null, signal: "SIGTERM", stdout: "" },
      { ...passed, status: null, error: new Error("fixture spawn refused"), stdout: "" },
      { ...passed, status: null, stdout: "" },
    ]) {
      const results: unknown[] = [passed, passed]; results[phase] = failure;
      const observed = run(results);
      assert.ok(observed.outcome.refusal, "unavailable measurement still refuses the commit/push guard");
      assert.match(observed.outcome.refusal.text, /NOT MEASURED/);
      assert.doesNotMatch(observed.outcome.refusal.text, /this branch grows/);
      assert.deepEqual(observed.outcome.refusal.censuses, []);
      assert.deepEqual(observed.outcome.refusal.offeredBaselines, []);
      assert.ok(observed.outcome.unmeasured);
      assert.equal(observed.calls, phase + 1, "a failed precheck starts no second child");
      assert.equal((observed.events.at(-1)!.data as { outcome: string }).outcome, "refused");
    }
  }
  const missing = run([passed, { ...passed, stdout: "TAP version 13\n" }]);
  assert.match(missing.outcome.refusal!.text, /NOT MEASURED/);
  const unrecognised = run([{ ...passed, status: 1, stdout: "precheck could not start" }]);
  assert.match(unrecognised.outcome.refusal!.text, /NOT MEASURED/);
  assert.equal(unrecognised.calls, 1);
  const measuredText = "census-precheck: this branch grows 1 census count(s) CI will refuse:\n  fixture-copy: real observed growth";
  const measured = run([{ ...passed, status: 1, stdout: measuredText }]);
  assert.equal(measured.outcome.refusal!.text, measuredText);
  assert.deepEqual(measured.outcome.refusal!.censuses, ["fixture-copy"]);
  assert.equal(measured.outcome.unmeasured, undefined);
  assert.equal(measured.calls, 1);
  const failedSuite = run([passed, { ...passed, status: 1, stdout: "# tests 1\n# fail 1\n" }]);
  assert.match(failedSuite.outcome.refusal!.text, /census-suite:/);
  assert.equal(failedSuite.outcome.unmeasured, undefined);
});
