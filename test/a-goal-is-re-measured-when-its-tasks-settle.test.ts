import test from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stringify } from "yaml";
import { loadGoals, measureGoal, remeasureSettledGoals, withGoalRemeasurement, type GoalRecord } from "../src/lib/goals.js";
import { fixedClock } from "../src/lib/clock.js";
import { buildGather, renderGather } from "../src/lib/retro.js";
import { parseTasksFromYaml, type Task } from "../src/lib/plan.js";
import { writeLedger } from "./helpers/ledger-fixture.js";
import { deriveAnalyticsSnapshot, deriveAnalyticsSnapshotFromCheckpointedLedger, buildAnalyticsRoute } from "../src/lib/analytics-route.js";

const clock = fixedClock(Date.parse("2026-10-02T12:00:00Z"));
const goal: GoalRecord = { id: "G-flow", symptom: "PRs wait", measurement: "pr-flow-minutes", direction: "decrease",
  baseline: { value: 10, observedAt: "2026-10-01T12:00:00Z", source: "positive-control" }, tasks: ["W1-T1", "W1-T2"] };
const tasks = goal.tasks.map((id) => ({ id } as Task));
const rows = [
  { step: "pr.opened", pr_url: "https://example.invalid/pull/1", ts: "2026-10-02T10:00:00Z" },
  { step: "verdict.merged", pr_url: "https://example.invalid/pull/1", ts: "2026-10-02T10:05:00Z" },
  { step: "implement.done", task_id: "W1-T1", ts: "2026-10-02T10:01:00Z", total_cost_usd: 1 },
  { step: "implement.done", task_id: "W1-T2", ts: "2026-10-02T10:02:00Z" },
];

test("W1-T4684: a goal is re-measured when its last task settles", async () => {
  const fixture = writeLedger(rows);
  const emitted: unknown[] = [];
  const input = { repoRoot: fixture.dir, stateDir: fixture.dir, tasks, goals: [goal], clock, log: (step: string, fields: unknown) => emitted.push({ step, fields }) };
  try {
    assert.deepEqual(await remeasureSettledGoals({ ...input, settled: (id) => id === "W1-T1" }), []);
    assert.deepEqual(await remeasureSettledGoals({ ...input, settled: () => undefined }), []);
    const settled = await remeasureSettledGoals({ ...input, settled: () => true });
    assert.equal(settled[0]!.step, "goal.moved");
    assert.equal(settled[0]!.value, 5);
    assert.equal(settled[0]!.baseline, 10);
    assert.equal(settled[0]!.pricedUsd, 1);
    assert.equal(settled[0]!.unpricedRows, 1);
    assert.equal(settled[0]!.costComplete, false);
    assert.deepEqual(await remeasureSettledGoals({ ...input, settled: () => true }), [], "same task set is measured once");
    assert.equal(emitted.length, 1);
  } finally { rmSync(fixture.dir, { recursive: true, force: true }); }
});

test("W1-T4684: an unmoved goal is handed to the retro", async () => {
  const fixture = writeLedger(rows);
  const ledger: Record<string, unknown>[] = [];
  try {
    await remeasureSettledGoals({ repoRoot: fixture.dir, stateDir: fixture.dir, tasks, goals: [{ ...goal, direction: "increase" }], rows,
      clock, settled: () => true, log: (step, fields) => ledger.push({ ...fields, step }) });
    const gather = buildGather({ ledgerNdjson: ledger.map((row) => JSON.stringify(row)).join("\n"), learningsMd: "" });
    assert.equal(gather.unmovedGoals!.length, 1);
    assert.match(renderGather(gather), /G-flow: 10 -> 5/);
    assert.match(renderGather(gather), /governed plan/);
  } finally { rmSync(fixture.dir, { recursive: true, force: true }); }
});

test("goal measurement commands are typed ledger queries with positive controls", () => {
  assert.equal(measureGoal("pr-flow-minutes", []), null);
  assert.equal(measureGoal("pr-flow-minutes", [...rows, { step: "pr.opened", pr_url: "x", ts: "2026-10-02T10:00:00Z" }, { step: "verdict.merged", pr_url: "x", ts: "2026-10-02T10:15:00Z" }]), 10);
  assert.equal(measureGoal("ci-friction-minutes", []), null);
  assert.equal(measureGoal("ci-friction-minutes", [{ step: "ci-friction.scorecard", priced: [{ minutes: "unknown" }] }]), null);
  assert.equal(measureGoal("ci-friction-minutes", [{ step: "ci-friction.scorecard", priced: [{ minutes: 20 }, { minutes: 5 }] }]), 25);
  assert.equal(measureGoal("terminal-missing-percent", []), null);
  assert.equal(measureGoal("terminal-missing-percent", [{ step: "worker.assignment", worker_assignment: { id: "a" } }, { step: "worker.assignment", worker_assignment: { id: "b" } }, { step: "implement.done", selection_assignment_id: "a" }]), 50);
});

test("goals load from their own records and the task parser retains goal membership", () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-goal-records-"));
  try {
    assert.deepEqual(loadGoals(root), []);
    mkdirSync(join(root, "plan", "goals.d"), { recursive: true });
    const path = join(root, "plan", "goals.d", "G-flow.yaml");
    writeFileSync(path, stringify(goal));
    assert.deepEqual(loadGoals(root), [goal]);
    writeFileSync(path, stringify({ ...goal, measurement: "rm -rf" }));
    assert.throws(() => loadGoals(root), /invalid goal record/);
    const task = parseTasksFromYaml(stringify([{ id: "W1-T1", repo: "remudero", title: "control", type: "implement", goal: "G-flow" }]), "fixture")[0]!;
    assert.equal(task.goal, "G-flow");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a missing measurement stays unmeasured and a wrapper failure never turns a successful sweep red", async () => {
  const fixture = writeLedger([]);
  const logs: string[] = [];
  try {
    const observation = await remeasureSettledGoals({ repoRoot: fixture.dir, stateDir: fixture.dir, tasks, goals: [goal], rows: [], clock,
      settled: () => true, log: (step) => logs.push(step) });
    assert.equal(observation[0]!.step, "goal.unmeasured");
    assert.equal(observation[0]!.value, null);
    const sweep = withGoalRemeasurement(async () => "successful", async () => { throw new Error("measurement failed"); }, (step) => logs.push(step));
    assert.equal(await sweep(), "successful");
    assert.ok(logs.includes("goal.remeasurement_failed"));
    assert.equal(await withGoalRemeasurement(async () => 1, async () => 2, () => {} )(), 1);
  } finally { rmSync(fixture.dir, { recursive: true, force: true }); }
});

test("measurement order and duplicate merge receipts cannot change the PR sample", () => {
  assert.equal(measureGoal("pr-flow-minutes", [rows[1]!, rows[1]!, rows[0]!]), 5);
  const assignment = { step: "worker.assignment", worker_assignment: { id: "a" } };
  assert.equal(measureGoal("terminal-missing-percent", [assignment, { step: "routing.decision", selection_assignment_id: "a" }]), 100);
});

test("incomplete and bounded sources stay unmeasured, and a later measurement can retry", async () => {
  const fixture = writeLedger(rows);
  const input = { repoRoot: fixture.dir, stateDir: fixture.dir, tasks, goals: [goal], clock, settled: () => true, log: () => {} };
  try {
    const bounded = await remeasureSettledGoals({ ...input, maxRows: 1 });
    assert.equal(bounded[0]!.step, "goal.unmeasured");
    assert.equal(bounded[0]!.reason, "retention-budget");
    assert.equal(bounded[0]!.costComplete, false);
    assert.deepEqual(await remeasureSettledGoals(input), [], "unmeasured retries are paced");
    const retry = await remeasureSettledGoals({ ...input, clock: fixedClock(clock.now() + 86_400_001) });
    assert.equal(retry[0]!.step, "goal.moved");
    appendFileSync(join(fixture.dir, "ledger.ndjson"), '{bad}\n');
    const malformed = await remeasureSettledGoals({ ...input, goals: [{ ...goal, baseline: { ...goal.baseline, value: 20 } }] });
    assert.equal(malformed[0]!.step, "goal.unmeasured");
    assert.match(malformed[0]!.reason!, /malformed-row/);
  } finally { rmSync(fixture.dir, { recursive: true, force: true }); }
});

test("goal projection and checkpoint resume retain only validated latest receipts", async () => {
  const fixture = writeLedger(rows);
  const emitted: Record<string, unknown>[] = [];
  try {
    await remeasureSettledGoals({ repoRoot: fixture.dir, stateDir: fixture.dir, tasks, goals: [goal], rows, clock, settled: () => true,
      log: (step, fields) => emitted.push({ ...fields, step }) });
    fixture.append(emitted);
    const first = await deriveAnalyticsSnapshotFromCheckpointedLedger(fixture.dir, clock);
    assert.equal(first.snapshot.goalObservations![0]!.value, 5);
    const legacy = structuredClone(first.checkpoint);
    delete legacy.state.goalAccountingVersion;
    delete legacy.state.goalObservations;
    const rescanned = await deriveAnalyticsSnapshotFromCheckpointedLedger(fixture.dir, clock, undefined, legacy);
    assert.equal(rescanned.snapshot.goalObservations!.length, 1);
    const resumed = await deriveAnalyticsSnapshotFromCheckpointedLedger(fixture.dir, clock, undefined, rescanned.checkpoint);
    assert.equal(resumed.snapshot.goalObservations!.length, 1);
    const invalid = { ...emitted[0], goal_id: "G-forged", value: "free text", secret: "no" };
    assert.equal(deriveAnalyticsSnapshot([invalid], clock.iso()).goalObservations!.length, 0);
    let body = "";
    const route = buildAnalyticsRoute({ currentSnapshot: () => resumed.snapshot });
    await route.handler({ url: "/v1/analytics?projectionVersion=goals-v1" } as never, { writeHead: () => {}, end: (s: string) => { body = s; } } as never, { params: {} });
    assert.equal(JSON.parse(body).goals[0].costBasis, "produced-ledger-receipts");
    assert.equal(JSON.parse(body).version, "goals-v1");
    const gather = buildGather({ ledgerNdjson: [{ ...emitted[0], step: "goal.unmoved" }, emitted[0]].map(r => JSON.stringify(r)).join("\n"), learningsMd: "" });
    assert.equal(gather.unmovedGoals!.length, 0, "a later moved receipt clears the retro candidate");
  } finally { rmSync(fixture.dir, { recursive: true, force: true }); }
});


test("future goal receipts cannot establish movement or complete cost", async () => {
  const fixture = writeLedger([...rows, { ...rows[1], ts: "2026-10-03T12:00:00Z" }]);
  try {
    const output = await remeasureSettledGoals({ repoRoot: fixture.dir, stateDir: fixture.dir, tasks, goals: [goal],
      clock, settled: () => true, log: () => {} });
    assert.equal(output[0]!.step, "goal.unmeasured");
    assert.equal(output[0]!.value, null);
    assert.match(output[0]!.reason!, /future-timestamp/);
    assert.equal(output[0]!.costComplete, false);
  } finally { rmSync(fixture.dir, { recursive: true, force: true }); }
});
