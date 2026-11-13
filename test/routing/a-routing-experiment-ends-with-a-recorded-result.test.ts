import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { gzipSync } from "node:zlib";
import { experimentArmForTask, ROUTING_EXPERIMENTS, type RoutingExperiment } from "#src/lib/routing-experiments.js";
import { evaluateRoutingExperimentResult, recordRoutingExperimentResults, requiredRoutingTasksPerArm } from "#src/lib/routing-experiment-result.js";
import { buildMeasurementCadenceDaemonHooks } from "#src/run-task.js";
import type { Config } from "#src/lib/config.js";

type Row = Record<string, unknown>;
const experiment: RoutingExperiment = { ...ROUTING_EXPERIMENTS[0]!, id: "result-fixture",
  startedOn: "2026-11-01", minTasksPerArm: 2,
  decision: { minimumDifference: 0.5, power: 0.8, confidence: 0.95, stopOn: "2026-11-30" } };
const today = "2026-11-13";
const ts = `${today}T10:00:00.000Z`;
const labels = Object.values(experiment.arms) as string[];
const tasks = (arm: string, count: number) => Array.from({ length: 10000 }, (_, i) => `W1-T${i + 1}`)
  .filter(task => experimentArmForTask(experiment, task).arm === arm).slice(0, count);

function assignment(task: string, id: string, served = "codex"): Row {
  return { ts, task_id: task, step: "worker.assignment", worker_assignment: { id,
    selected: { provider: served }, routing: { decision: { ab: experiment.id },
      experiment: { assignedArm: "deliberately-wrong" } } } };
}
function outcome(task: string, id: string, pipeline: string, success: boolean, extra: Row = {}): Row {
  return { ts, task_id: task, selection_assignment_id: id,
    step: pipeline === "build" ? success ? "verdict.merged" : "verdict" : pipeline === "fix" ? "fix.done" : "review.posted",
    verdict: success ? "merged" : "failed", subtype: success ? "success" : "failure",
    state: success ? "success" : "failure", total_cost_usd: 2, worker_duration_ms: 60000, ...extra };
}
function cohort(count: number, different: boolean): Row[] {
  return labels.flatMap((arm, armIndex) => tasks(arm, count).flatMap(task => [assignment(task, task),
    outcome(task, task, "build", different ? armIndex === 0 : true)]));
}

test("W1-T12142 criterion 1: assigned arms keep build, fix and review outcomes separate", () => {
  const task = tasks(labels[0]!, 1)[0]!;
  const rows = [assignment(task, "build"), assignment(task, "fix"), assignment(task, "review"), assignment(task, "pending"),
    outcome(task, "build", "build", true), outcome(task, "fix", "fix", true), outcome(task, "review", "review", false),
    outcome("W1-T99999", "pending", "build", true), outcome(task, "unknown", "build", true),
    { ...outcome(task, "pending", "build", true), selection_assignment_id: undefined }];
  const result = evaluateRoutingExperimentResult(rows, experiment, today);
  const arm = result.arms.find(item => item.arm === labels[0])!;
  assert.equal(arm.tasks, 1);
  assert.equal(arm.pipelines.build.positive, 1);
  assert.equal(arm.pipelines.fix.positive, 1);
  assert.equal(arm.pipelines.review.positive, 1);
  for (const pipeline of Object.values(arm.pipelines)) {
    assert.equal(pipeline.assignments, 1);
    assert.equal(pipeline.medianCostUsd, 2);
    assert.equal(pipeline.medianDurationMs, 60000);
  }
  assert.equal(result.assignmentsWithoutOutcome, 1);
  assert.equal(result.crossoverShare, labels[0] === experiment.arms.codex ? 0 : 1);
  assert.equal(result.arms.find(item => item.arm === labels[1])!.tasks, 0);
  assert.deepEqual(evaluateRoutingExperimentResult([...rows].reverse(), experiment, today), result);
});

test("W1-T12142 criterion 2: intervals resample tasks rather than attempts and are reproducible", () => {
  const rows = cohort(8, false);
  const first = tasks(labels[0]!, 8);
  rows.push(...first.slice(0, 4).flatMap(task => [assignment(task, `${task}-fail`), outcome(task, `${task}-fail`, "build", false)]));
  const baseline = evaluateRoutingExperimentResult(rows, experiment, today);
  const repeated = [...rows];
  for (let n = 0; n < 40; n++) {
    const task = first[0]!;
    repeated.push(assignment(task, `retry-${n}`), outcome(task, `retry-${n}`, "build", true),
      assignment(task, `fail-${n}`), outcome(task, `fail-${n}`, "build", false));
  }
  const result = evaluateRoutingExperimentResult(repeated, experiment, today);
  assert.equal(result.arms[0]!.pipelines.build.tasks, 8);
  assert.deepEqual(result.differences.build.rate, baseline.differences.build.rate);
  assert.deepEqual(evaluateRoutingExperimentResult(repeated, experiment, today), result);
  assert.ok(result.differences.build.rate!.lower < result.differences.build.rate!.upper);
  for (const pipeline of Object.values(baseline.differences)) {
    for (const metric of Object.values(pipeline)) {
      if (metric) assert.equal(metric.method, "task-bootstrap");
    }
  }
});

test("W1-T12142 criterion 3: every rule determines its required sample with the configured floor", () => {
  const rule = { minimumDifference: 0.1, power: 0.8, confidence: 0.95, stopOn: "2026-11-30" };
  assert.equal(requiredRoutingTasksPerArm({ ...experiment, decision: rule }), 392);
  assert.equal(requiredRoutingTasksPerArm({ ...experiment, minTasksPerArm: 500, decision: rule }), 500);
  assert.ok(requiredRoutingTasksPerArm({ ...experiment, decision: { ...rule, power: 0.9 } }) > 392);
  assert.ok(requiredRoutingTasksPerArm({ ...experiment, decision: { ...rule, confidence: 0.99 } }) > 392);
  for (const live of ROUTING_EXPERIMENTS) {
    assert.ok(live.decision.stopOn >= live.startedOn);
    assert.ok(requiredRoutingTasksPerArm(live) >= live.minTasksPerArm);
  }
  for (const decision of [{ ...rule, minimumDifference: 0 }, { ...rule, confidence: 1 },
    { ...rule, power: 0.4 }, { ...rule, stopOn: "invalid" }]) {
    assert.throws(() => requiredRoutingTasksPerArm({ ...experiment, decision }), /decision/);
  }
});

test("W1-T12142 criterion 4: results run, conclude or stop underpowered using distinct tasks", () => {
  const needed = requiredRoutingTasksPerArm(experiment);
  assert.equal(evaluateRoutingExperimentResult(cohort(1, true), experiment, today).status, "running");
  const winner = evaluateRoutingExperimentResult(cohort(needed, true), experiment, today);
  assert.equal(winner.status, "concluded");
  assert.equal(winner.winner, labels[0]);
  const moderate = cohort(30, false);
  const worse = new Set(tasks(labels[1]!, 30).slice(0, 18));
  for (const row of moderate) {
    if (row.step === "verdict.merged" && worse.has(String(row.task_id))) {
      row.step = "verdict"; row.verdict = "failed";
    }
  }
  assert.equal(evaluateRoutingExperimentResult(moderate, experiment, today).winner, labels[0]);
  const equal = evaluateRoutingExperimentResult(cohort(needed, false), experiment, today);
  assert.equal(equal.status, "concluded");
  assert.equal(equal.winner, null);
  assert.equal(equal.conclusion, "no-difference");
  assert.equal(evaluateRoutingExperimentResult(cohort(1, true), experiment, experiment.decision.stopOn).status, "underpowered");
  const repeats = Array.from({ length: needed * 2 }, (_, n) => {
    const task = tasks(labels[n % 2]!, 1)[0]!;
    return [assignment(task, `repeat-${n}`), outcome(task, `repeat-${n}`, "build", true)];
  }).flat();
  assert.equal(evaluateRoutingExperimentResult(repeats, experiment, experiment.decision.stopOn).status, "underpowered");
  const future = cohort(needed, true).map(row => ({ ...row, ts: "2026-12-01T00:00:00Z" }));
  assert.equal(evaluateRoutingExperimentResult(future, experiment, experiment.decision.stopOn).status, "underpowered");
});

test("W1-T12142 criterion 5: the real ledger writer dedupes each experiment and utc day over all forms", async () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-routing-results-"));
  try {
    const stateDir = join(root, "state"); mkdirSync(stateDir);
    const rows = cohort(2, true);
    const encode = (items: unknown[]) => items.map(row => JSON.stringify(row)).join("\n") + "\n";
    writeFileSync(join(stateDir, "ledger.2026-11-13T09-00-00-000Z.ndjson.gz"), gzipSync(encode(rows.slice(0, 2))));
    writeFileSync(join(stateDir, "ledger.2026-11-13T09-30-00-000Z.ndjson"), encode(rows.slice(2)));
    const ledger = join(stateDir, "ledger.ndjson"); writeFileSync(ledger, "");
    const opts = { stateDir, today, experiments: [experiment] };
    assert.equal((await recordRoutingExperimentResults(opts)).length, 1);
    const recorded = JSON.parse(readFileSync(ledger, "utf8").trim());
    assert.equal(recorded.step, "routing.experiment.result");
    assert.equal(recorded.result.assignments, 4);
    assert.equal((await recordRoutingExperimentResults(opts)).length, 0);
    writeFileSync(join(stateDir, "ledger.2026-11-13T11-00-00-000Z.ndjson"), encode([recorded]));
    writeFileSync(ledger, "");
    assert.equal((await recordRoutingExperimentResults(opts)).length, 0);
    assert.equal((await recordRoutingExperimentResults({ ...opts, today: "2026-11-14" })).length, 1);
    assert.equal(JSON.parse(readFileSync(ledger, "utf8").trim()).day, "2026-11-14");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("W1-T12142 criterion 6: the production cadence invokes the real result pass", async () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-routing-cadence-"));
  try {
    const hooks = buildMeasurementCadenceDaemonHooks({ config: { root } as Config,
      now: () => new Date(ts), verifyHumanCadenceResult: async () => { throw new Error("fixture stops sibling work"); } });
    await assert.rejects(hooks.runMeasurementCadence(), /fixture stops sibling work/);
    const rows = readFileSync(join(root, "state", "ledger.ndjson"), "utf8").trim().split("\n").map(line => JSON.parse(line));
    assert.equal(rows.length, ROUTING_EXPERIMENTS.length);
    assert.ok(rows.every(row => row.step === "routing.experiment.result" && row.day === today));
    await assert.rejects(hooks.runMeasurementCadence(), /fixture stops sibling work/);
    assert.equal(readFileSync(join(root, "state", "ledger.ndjson"), "utf8").trim().split("\n").length, rows.length);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("terminal snapshots persist, unknown resources stay unknown and unreadable history refuses a result", async () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-routing-history-"));
  try {
    const rows = cohort(requiredRoutingTasksPerArm(experiment), true);
    for (const row of rows) { row.total_cost_usd = undefined; row.worker_duration_ms = undefined; }
    const measured = evaluateRoutingExperimentResult(rows, experiment, today);
    assert.equal(measured.arms[0]!.pipelines.build.medianCostUsd, null);
    assert.equal(measured.arms[0]!.pipelines.build.medianDurationMs, null);
    assert.equal(measured.differences.build.medianCostUsd, null);
    const stateDir = join(root, "state"); mkdirSync(stateDir);
    const encode = (items: unknown[]) => items.map(row => JSON.stringify(row)).join("\n") + "\n";
    writeFileSync(join(stateDir, "ledger.ndjson"), encode(rows));
    const opts = { stateDir, today, experiments: [experiment] };
    const [first] = await recordRoutingExperimentResults(opts);
    const [next] = await recordRoutingExperimentResults({ ...opts, today: "2026-11-14" });
    assert.deepEqual(next, { ...first, day: "2026-11-14" });
    writeFileSync(join(stateDir, "ledger.2026-11-13T12-00-00-000Z.ndjson.gz"), "corrupt gzip");
    await assert.rejects(recordRoutingExperimentResults({ ...opts, today: "2026-11-15" }), /ledger unreadable/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("pipeline decisions prefer merges and accepted fixes but fewer failed reviews", () => {
  const count = requiredRoutingTasksPerArm(experiment);
  const rows = labels.flatMap((arm, index) => tasks(arm, count).flatMap(task =>
    ["build", "fix", "review"].flatMap(pipeline => {
      const id = `${task}-${pipeline}`;
      return [assignment(task, id), outcome(task, id, pipeline, index === 0,
        { billing_mode: "subscription", total_cost_usd: 0, notional_cost_usd: 3 })];
    })));
  const result = evaluateRoutingExperimentResult(rows, experiment, today);
  assert.equal(result.winner, labels[0]);
  assert.equal(result.arms[0]!.pipelines.review.rate, 0);
  assert.equal(result.arms[1]!.pipelines.review.rate, 1);
  assert.equal(result.arms[0]!.pipelines.fix.medianCostUsd, 3);
  for (const pipeline of Object.values(result.differences)) {
    for (const interval of Object.values(pipeline)) assert.ok(interval);
  }
});

test("invalid dates and arm definitions refuse an experiment result", async () => {
  assert.throws(() => evaluateRoutingExperimentResult([], experiment, "invalid"), /invalid routing result day/);
  assert.throws(() => evaluateRoutingExperimentResult([], { ...experiment, arms: { claude: "only" } }, today), /two distinct arms/);
  await assert.rejects(recordRoutingExperimentResults({ stateDir: "/unused", today: "2026-02-30" }), /invalid routing result day/);
});
