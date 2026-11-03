import assert from "node:assert/strict";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { LoopBoundedChildTimeout } from "#src/lib/loop-bounded-child.js";
import { checkFixCensusSnapshot, checkFixCensusSnapshotAsync, spawnCensusChild } from "#src/run-task.js";
import { finishJudgedRun } from "#test/helpers/judged-pool-run.js";

// W1-T10332 (operator ruling 2026-10-21): a census child its own bound kills is "not measured", named by that child,
// and never refuses the round's commit; a child that ran and failed still refuses, naming itself.
const reach = "test/the-affected-suite-reach-ratchet.test.ts";
const passed = { status: 0, signal: null, stdout: "TAP version 13\n1..1\n# tests 1\n# pass 1\n# fail 0\n", stderr: "" };
// spawnSync's own shape for a child killed by its `timeout`: ETIMEDOUT beside the SIGTERM it sent.
const killedByBound = { status: null, signal: "SIGTERM", stdout: "", stderr: "",
  error: Object.assign(new Error("spawnSync node ETIMEDOUT"), { code: "ETIMEDOUT" }) };
const failedSuite = { status: 1, signal: null, stdout: "TAP version 13\n1..1\n# tests 1\n# pass 0\n# fail 1\n", stderr: "" };

type Event = { step: string; data?: Record<string, unknown> };
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

// The controller's budget inspector runs for real; the precheck and the reach suite get the given results in order.
function runSync(results: unknown[]) {
  const children: string[][] = [];
  const events: Event[] = [];
  const outcome = checkFixCensusSnapshot("/unused-injected-root", "/unused-snapshot", (step, data) => events.push({ step, data }),
    ((file: string, args: string[], options: Parameters<typeof spawnSync>[2]) => {
      if (args.includes("--snapshot-budget")) return spawnSync(file, args, options);
      const result = results[children.length] ?? passed;
      children.push(args);
      if ((result as { status?: unknown }).status === 0) finishJudgedRun(args, options);
      return result;
    }) as unknown as Parameters<typeof checkFixCensusSnapshot>[3]);
  return { outcome: outcome!, children, last: events.at(-1)! };
}

test("W1-T10332: a precheck that times out is not measured and names the precheck", async () => {
  const observed = runSync([killedByBound, passed]);
  assert.equal(observed.outcome.refusal, undefined, "the round's commit is not refused on a timeout");
  assert.match(observed.outcome.unmeasured!, /^census-precheck: not measured — scripts\/census-precheck\.mjs timed out at \d+ s \(SIGTERM\); CI and pre-push still measure$/);
  assert.doesNotMatch(observed.outcome.unmeasured!, /grows|the-affected-suite-reach-ratchet/);
  assert.equal(observed.children.length, 2, "a precheck timeout does not stop the reach suite from running");
  assert.ok(observed.children[1]!.includes(reach));
  assert.equal(observed.last.step, "fix.census_check");
  assert.equal(observed.last.data?.outcome, "partially-measured");
  assert.equal(observed.last.data?.timed_out_child, "scripts/census-precheck.mjs");
  assert.equal(observed.last.data?.refusal, undefined);

  const reachTimeout = runSync([passed, killedByBound]);
  assert.equal(reachTimeout.outcome.refusal, undefined);
  assert.match(reachTimeout.outcome.unmeasured!, /^census-precheck: not measured — test\/the-affected-suite-reach-ratchet\.test\.ts timed out at \d+ s/);
  assert.equal(reachTimeout.last.data?.timed_out_child, reach);

  // The daemon's async form, a real child stopped by spawnCensusChild's own loop bound.
  const events: Event[] = [];
  const live = await checkFixCensusSnapshotAsync("/unused-injected-root", "/unused-snapshot", (step, data) => events.push({ step, data }),
    (file, args, options) => args.includes("--snapshot-budget") ? spawnCensusChild(file, args, options)
      : spawnCensusChild(process.execPath, ["-e", noisySleeper], { ...options, timeout: 300 }));
  assert.equal(live?.refusal, undefined, "a timeout is not measured, so it never refuses the commit/push guard");
  assert.match(live!.unmeasured!, /^census-precheck: not measured — scripts\/census-precheck\.mjs timed out at 0\.3 s \(SIGTERM\)/m);
  assert.match(live!.unmeasured!, /^census-precheck: not measured — test\/the-affected-suite-reach-ratchet\.test\.ts timed out at 0\.3 s/m);
  assert.equal(events.at(-1)?.data?.outcome, "partially-measured");
  assert.equal(events.at(-1)?.data?.timed_out_child, `scripts/census-precheck.mjs, ${reach}`);
});

test("W1-T10332: a reach suite that runs and fails still refuses, naming the reach suite and never the precheck", () => {
  // #13121's shape: the precheck was the child killed; the reach suite then ran and really failed.
  const observed = runSync([killedByBound, failedSuite]);
  assert.ok(observed.outcome.refusal, "a reach suite that ran and failed still refuses the commit");
  assert.match(observed.outcome.refusal.text, new RegExp(`census-suite: ${reach.replace(/[.]/g, "\\.")} fails — `));
  assert.match(observed.outcome.refusal.text, /# fail 1/);
  assert.doesNotMatch(observed.outcome.refusal.text, /SIGTERM|ETIMEDOUT|census-precheck\.mjs/, "the refusal names the failing child, not the timed-out one");
  assert.deepEqual(observed.outcome.refusal.censuses, ["census-suite"]);
  assert.equal(observed.last.data?.outcome, "refused");

  // An outside kill or a spawn failure is not the bound's timeout: it keeps today's NOT MEASURED refusal.
  for (const failure of [{ ...passed, status: null, signal: "SIGTERM", stdout: "" },
    { ...passed, status: null, error: new Error("fixture spawn refused"), stdout: "" }]) {
    const refused = runSync([failure]);
    assert.match(refused.outcome.refusal!.text, /^census-precheck: NOT MEASURED — census precheck child: /);
    assert.equal(refused.last.data?.timed_out_child, undefined);
  }
});
