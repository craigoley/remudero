import assert from "node:assert/strict";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { runDrain, type DrainDeps } from "#src/lib/drain.js";
import { loadPlan } from "#src/lib/plan.js";
import type { RunResult } from "#src/lib/run-result.js";
import { checkQueueGovernor, DEFAULT_SWEEP_POLICY, logQueueGovernorDeferral } from "#src/lib/sweep.js";
import { makeTempDir } from "#src/lib/tmp.js";

const policy = { ...DEFAULT_SWEEP_POLICY, wipLimit: 3 };
const growing = checkQueueGovernor(3, policy);
const prUrl = "https://github.com/o/r/pull/10";
const step = "dispatch.expedite_past_wip";

function fixture(t: TestContext) {
  const dir = makeTempDir("expedite-wip");
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, "tasks.yaml");
  writeFileSync(file, JSON.stringify([
    { id: "ORDINARY", priority: 1 },
    { id: "NOT_READY", priority: 2, expedite: "waiting for ordinary work", depends_on: ["ORDINARY"] },
    { id: "LATER", priority: 20, expedite: "operator request" },
    { id: "FIRST", priority: 10, expedite: "fleet repair" },
  ].map((task) => ({
    title: task.id, repo: "remudero", type: "implement", files: [`src/${task.id}.ts`], status: "queued", ...task,
  }))));
  const plan = loadPlan(file);
  const rows: Record<string, unknown>[] = [];
  const started: string[] = [];
  const deps: DrainDeps = {
    refreshMerged: () => () => false,
    checkQueueGovernor: () => growing,
    openPrCount: () => 3,
    readLedgerLines: () => rows.map((row) => JSON.stringify(row)),
    log: (name, fields) => rows.push({ step: name, ...fields }),
    runOne: async (id) => { started.push(id); return result(id); },
  };
  return { plan, rows, started, deps };
}

function result(id: string, openPr?: string): RunResult {
  return { taskId: id, runId: `${id}-run`, prUrl: openPr, merged: !openPr, costUsd: 0,
    verdict: openPr ? "awaiting_merge" : "merged" };
}

test("W1-T15171 criterion 1: one ready expedited build passes a growing WIP hold and names the deferral", async (t) => {
  for (const laneCount of [1, 3]) {
    const { plan, rows, started, deps } = fixture(t);
    const run = await runDrain(plan, deps, { laneCount, wipLimit: 3, max: 1 });
    assert.deepEqual(run.attempted, ["FIRST"]);
    assert.deepEqual(started, ["FIRST"]);
    const deferrals: Record<string, unknown>[] = [];
    logQueueGovernorDeferral(growing, (_path, row) => deferrals.push(row), "", "drain");
    const { run_id, task_id, step: _step, ...governor } = deferrals[0]!;
    assert.deepEqual(rows.filter((row) => row.step === step), [{ step, task_id: "FIRST", governor }]);
  }
});

test("W1-T15171 criterion 2: a fresh drain holds while the admitted run has no PR or an open PR", async (t) => {
  const { plan, rows, started, deps } = fixture(t);
  const options = { laneCount: 3, wipLimit: 3, max: 1 };
  let settle!: (outcome: RunResult) => void;
  const running = new Promise<RunResult>((resolve) => { settle = resolve; });
  let announce!: () => void;
  const launched = new Promise<void>((resolve) => { announce = resolve; });
  const first = runDrain(plan, { ...deps, runOne: (taskId) => {
    started.push(taskId);
    rows.push({ step: "run.start", run_id: "FIRST-run", task_id: taskId });
    announce();
    return running;
  } }, options);
  await Promise.race([launched, first]);
  assert.deepEqual(started, ["FIRST"]);
  rows.push({ step: "verdict", task_id: "FIRST", run_id: "FIRST-older-run", verdict: "no_pr" });
  assert.equal((await runDrain(plan, deps, options)).stopReason, "queue_governor_deferred");
  rows.push({ step: "pr.opened", run_id: "FIRST-run", task_id: "FIRST", pr_url: prUrl });
  settle(result("FIRST", prUrl));
  await first;
  rows.push({ step: "pr.terminal", state: "closed", pr_url: "https://github.com/o/r/pull/11" });
  assert.deepEqual((await runDrain(plan, deps, options)).attempted, []);
  assert.equal(rows.filter((row) => row.step === step).length, 1);
  rows.push({ step: "pr.terminal", state: "closed", pr_url: prUrl });
  assert.deepEqual((await runDrain(plan, deps, { ...options, curated: ["LATER"] })).attempted, ["LATER"]);
});

test("W1-T15171 criterion 3: pressure holds expedites and ordinary dispatch keeps its existing WIP behavior", async (t) => {
  const { plan, rows, started, deps } = fixture(t);
  const pressured = checkQueueGovernor(3, policy, {
    pressure: { availableMib: policy.memoryFloorMib, floorMib: policy.memoryFloorMib },
    adaptiveBound: policy.wipLimit,
  });
  assert.equal(pressured.tier, "growing");
  assert.equal(pressured.pressureHeld, true);
  for (const laneCount of [1, 3]) {
    const held = await runDrain(plan, { ...deps, checkQueueGovernor: () => pressured }, { laneCount, max: 1 });
    assert.equal(held.stopReason, "queue_governor_deferred");
    const ordinaryOnly = await runDrain(plan, deps, { laneCount, max: 1, curated: ["ORDINARY"] });
    assert.equal(ordinaryOnly.stopReason, "queue_governor_deferred");
  }
  assert.deepEqual(started, []);
  assert.ok(!rows.some((row) => row.step === step));
  const admitted = await runDrain(plan, { ...deps, checkQueueGovernor: () => undefined }, { max: 1 });
  assert.deepEqual(admitted.attempted, ["ORDINARY"]);
});

test("an expedited start rechecks queue pressure after selecting a task", async (t) => {
  const { plan, rows, deps } = fixture(t);
  const pressured = checkQueueGovernor(3, policy, { pressure: { availableMib: 0, floorMib: policy.memoryFloorMib } });
  for (const laneCount of [1, 3]) {
    let reads = 0;
    const held = await runDrain(plan, {
      ...deps, checkQueueGovernor: () => reads++ === 0 ? growing : pressured,
    }, { laneCount, max: 1 });
    assert.equal(reads, 2);
    assert.equal(held.stopReason, "queue_governor_deferred");
    assert.deepEqual(held.attempted, []);
  }
  assert.ok(!rows.some((row) => row.step === step));
});

test("an unreadable expedited admission history holds the queue", async (t) => {
  const { plan, rows, deps } = fixture(t);
  const held = await runDrain(plan, {
    ...deps, readLedgerLines: () => { throw new Error("ledger read failed"); },
  }, { max: 1 });
  assert.deepEqual(held.attempted, []);
  assert.equal(held.stopReason, "queue_governor_deferred");
  assert.ok(rows.some((row) => row.step === "drain.queue_governor.unreadable" && row.error === "Error: ledger read failed"));
});
