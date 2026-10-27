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

test("a census precheck stopped by its bound refuses as NOT MEASURED and names the budget", async () => {
  const events: Array<{ step: string; data?: Record<string, unknown> }> = [];
  const outcome = await checkFixCensusSnapshotAsync("/unused-injected-root", "/unused-snapshot", (step, data) => events.push({ step, data }),
    // The controller's own budget inspector runs for real; only the precheck child is the over-budget sleeper.
    (file, args, options) => args.includes("--snapshot-budget") ? spawnCensusChild(file, args, options)
      : spawnCensusChild(process.execPath, ["-e", noisySleeper], { ...options, timeout: 300 }));
  assert.ok(outcome?.refusal, "an unmeasured census still refuses the commit/push guard");
  assert.match(outcome.refusal.text, /^census-precheck: NOT MEASURED — census precheck child: LoopBoundedChildTimeout: Command failed: /);
  assert.match(outcome.refusal.text, /stopped by SIGTERM at its 300ms loop-available budget$/);
  assert.deepEqual(outcome.refusal.censuses, []);
  assert.match(outcome.unmeasured!, /300ms loop-available budget/);
  assert.equal(events.at(-1)?.step, "fix.census_check");
  assert.equal(events.at(-1)?.data?.outcome, "refused");
});
