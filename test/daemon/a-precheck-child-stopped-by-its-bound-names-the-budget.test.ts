import assert from "node:assert/strict";
import { test } from "node:test";
import { LoopBoundedChildTimeout } from "#src/lib/loop-bounded-child.js";
import { checkFixCensusSnapshotAsync, spawnCensusChild } from "#src/run-task.js";

// A child that writes more than the refusal's 4,000-character tail to stderr, then outlives any budget below.
const noisySleeper = `process.stderr.write("x".repeat(5000)); setTimeout(() => {}, 30_000);`;

test("a census child stopped by its own time bound says so, where an outside SIGTERM stays a bare signal", async () => {
  const bounded = await spawnCensusChild(process.execPath, ["-e", noisySleeper], { encoding: "utf8", timeout: 300 });
  assert.equal(bounded.status, null);
  assert.equal(bounded.signal, "SIGTERM");
  assert.ok(bounded.error instanceof LoopBoundedChildTimeout, "the bound's kill keeps its named error beside the signal, as spawnSync's ETIMEDOUT does");
  assert.equal(bounded.error.budgetMs, 300);
  assert.match(bounded.error.message, /stopped by SIGTERM at its 300ms loop-available budget$/);
  assert.equal(bounded.stderr.length, 5000, "the child's output stays on stderr, not inside the error's text");

  const outside = await spawnCensusChild(process.execPath, ["-e", "process.kill(process.pid, 'SIGTERM')"], { encoding: "utf8", timeout: 30_000 });
  assert.equal(outside.signal, "SIGTERM");
  assert.equal(outside.error, undefined, "a SIGTERM the bound did not send carries no budget error");
});

test("a census precheck stopped by its bound is not measured and names the child and its budget (W1-T10332)", async () => {
  const events: Array<{ step: string; data?: Record<string, unknown> }> = [];
  const outcome = await checkFixCensusSnapshotAsync("/unused-injected-root", "/unused-snapshot", (step, data) => events.push({ step, data }),
    // The controller's own budget inspector runs for real; the precheck and the reach suite are over-budget sleepers.
    (file, args, options) => args.includes("--snapshot-budget") ? spawnCensusChild(file, args, options)
      : spawnCensusChild(process.execPath, ["-e", noisySleeper], { ...options, timeout: 300 }));
  assert.equal(outcome?.refusal, undefined, "a timeout is not measured, so it never refuses the commit/push guard");
  assert.match(outcome!.unmeasured!, /^census-precheck: not measured — scripts\/census-precheck\.mjs timed out at 0\.3 s \(SIGTERM\); CI and pre-push still measure$/m);
  assert.equal(events.at(-1)?.step, "fix.census_check");
  assert.equal(events.at(-1)?.data?.outcome, "partially-measured");
  assert.match(String(events.at(-1)?.data?.timed_out_child), /^scripts\/census-precheck\.mjs, /);
});
