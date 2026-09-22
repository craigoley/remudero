import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadPlan, type Plan, type Task } from "../src/lib/plan.js";
import {
  routeVerifyHumanBacklog,
  priorVerifyHumanVerdicts,
  type RunResult,
  type VerifyHumanRouteResult,
} from "../src/run-task.js";
import {
  hasRepeatedTaskAttributableLifetimeDispatches,
  taskAttributableLifetimeDispatches,
} from "../src/lib/status.js";
import {
  runDrain,
  type MergedSet,
} from "../src/lib/drain.js";
import { runDaemon, type DaemonDeps } from "../src/lib/daemon.js";
import type { ShardUnderJudgement, VerifyHumanVerdict } from "../src/lib/verify-human-judge.js";

const PLAN_YAML = `
- id: T4025-A
  title: adaptive A
  repo: remudero
  type: implement
  depends_on: []
  status: queued
- id: T4025-B
  title: adaptive B
  repo: remudero
  type: implement
  depends_on: []
  status: queued
`;

function fixturePlan(): { plan: Plan; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "rmd-t4025-"));
  const path = join(dir, "tasks.yaml");
  writeFileSync(path, PLAN_YAML);
  return { plan: loadPlan(path), dir };
}

function shard(id: string, observationKey: string): ShardUnderJudgement {
  return {
    id,
    title: `${id} title`,
    rationale: "repeated work was observed",
    acceptance: ["preserve the existing flow"],
    ageDays: 1,
    depsAllMerged: true,
    citedInSrc: false,
    evidence: `dispatch evidence for ${id}`,
    observationKey,
  };
}

function okResult(taskId: string): RunResult {
  return { taskId, runId: `${taskId}-run`, merged: true, costUsd: 0, verdict: "merged" };
}

async function route(
  shards: readonly ShardUnderJudgement[],
  judge: (input: ShardUnderJudgement) => Promise<VerifyHumanVerdict>,
  priorVerdicts: ReadonlyMap<string, VerifyHumanVerdict> = new Map(),
  rows: Record<string, unknown>[] = [],
  proposals: Array<{ id: string; summary: string }> = [],
): Promise<VerifyHumanRouteResult> {
  return routeVerifyHumanBacklog(shards, {
    judge,
    priorVerdicts,
    appendRow: (row) => rows.push(row),
    stageProposal: (proposal) => {
      if (!proposals.some((existing) => existing.id === proposal.id)) proposals.push(proposal);
    },
    runId: "W1-T4025-TEST",
  });
}

test("unit test: W1-T4025 lifetime signal remains observable without a terminal cap", async () => {
  const { plan, dir } = fixturePlan();
  try {
    const pressured: string[] = [];
    const summary = await runDrain(
      plan,
      {
        refreshMerged: () => (() => false) as MergedSet,
        isLifetimeCapExceeded: () => true,
        onLifetimePressure: async (tasks) => {
          pressured.push(...tasks.map((task) => task.id));
        },
        runOne: async (taskId) => okResult(taskId),
      },
      { max: 1 },
    );
    assert.deepEqual(summary.attempted, ["T4025-A"], "the old cap signal does not refuse the task");
    assert.deepEqual(pressured, ["T4025-A"], "the signal remains observable for adaptive routing");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("unit test: W1-T4025 repeated dispatch reaches the three-way judge", async () => {
  const shards = [
    shard("needs_operator", "needs-v1"),
    shard("automate", "automate-v1"),
    shard("backlog", "backlog-v1"),
  ];
  const judged: string[] = [];
  const result = await route(shards, async (input) => {
    judged.push(input.id);
    const decision = input.id as "needs_operator" | "automate" | "backlog";
    return { decision, reason: `judge selected ${decision}` };
  });
  assert.deepEqual(judged, ["needs_operator", "automate", "backlog"]);
  assert.deepEqual(result.needsOperator, ["needs_operator"]);
  assert.deepEqual(result.automated, ["automate"]);
  assert.deepEqual(result.backlog, ["backlog"]);
});

test("unit test: W1-T4025 automate stages one idempotent proposal", async () => {
  const current = shard("T4025-AUTO", "T4025-AUTO:evidence-1");
  const rows: Record<string, unknown>[] = [];
  const proposals: Array<{ id: string; summary: string }> = [];
  const judge = async () => ({ decision: "automate" as const, reason: "safe self-improvement candidate" });
  const first = await route([current], judge, new Map(), rows, proposals);
  const second = await route([current], judge, priorVerifyHumanVerdicts(rows), rows, proposals);
  assert.deepEqual(first.automated, [current.id]);
  assert.deepEqual(second.skipped, [current.id]);
  assert.equal(proposals.length, 1, "the same observed state stages one proposal");
  assert.match(proposals[0].summary, /Evidence: dispatch evidence/);
  assert.match(proposals[0].summary, /Judge provenance: decision=automate/);
});

test("unit test: W1-T4025 unchanged evidence deduplicates and material advance re-evaluates", async () => {
  const rows: Record<string, unknown>[] = [];
  let calls = 0;
  const judge = async () => {
    calls++;
    return { decision: "backlog" as const, reason: "re-evaluate later" };
  };
  const first = shard("T4025-ADVANCE", "T4025-ADVANCE:dispatches=2");
  await route([first], judge, new Map(), rows);
  const unchanged = await route([first], judge, priorVerifyHumanVerdicts(rows), rows);
  const advanced = shard("T4025-ADVANCE", "T4025-ADVANCE:dispatches=3");
  const changed = await route([advanced], judge, priorVerifyHumanVerdicts(rows), rows);
  assert.deepEqual(unchanged.skipped, [first.id]);
  assert.deepEqual(changed.backlog, [advanced.id]);
  assert.equal(calls, 2, "only material evidence advance re-opens the judge");
});

test("unit test: W1-T4025 unavailable judge fails open to needs_operator", async () => {
  const rows: Record<string, unknown>[] = [];
  const result = await route([shard("T4025-OUTAGE", "T4025-OUTAGE:v1")], async () => {
    throw new Error("provider unavailable");
  }, new Map(), rows);
  assert.deepEqual(result.needsOperator, ["T4025-OUTAGE"]);
  assert.equal(rows[0].judge_failed, true, "the retryable failure remains visible");
});

test("unit test: W1-T4025 orphan and capacity refusals do not spend task pressure", () => {
  const taskId = "T4025-ATTRIBUTION";
  const capacityOnly = [
    { ts: "2026-09-22T00:01:00.000Z", task_id: "DAEMON", task: taskId, step: "daemon.spawn_infra_blocked" },
    { ts: "2026-09-22T00:02:00.000Z", task_id: "DAEMON", task: taskId, step: "daemon.spawn_infra_blocked" },
    { ts: "2026-09-22T01:00:00.000Z", step: "daemon.heartbeat" },
  ];
  assert.equal(taskAttributableLifetimeDispatches(capacityOnly, taskId), 0);
  const realFailure = [
    { ts: "2026-09-22T00:00:00.000Z", task_id: taskId, run_id: "real", step: "run.start" },
    { ts: "2026-09-22T00:01:00.000Z", task_id: taskId, run_id: "real", step: "implement.done", verdict: "failed" },
    { ts: "2026-09-22T00:02:00.000Z", task_id: taskId, run_id: "orphan", step: "run.start" },
    { ts: "2026-09-22T01:00:00.000Z", step: "daemon.heartbeat" },
  ];
  assert.equal(taskAttributableLifetimeDispatches(realFailure, taskId), 1, "a real worker failure remains attributable");
  assert.equal(hasRepeatedTaskAttributableLifetimeDispatches(realFailure, taskId), false);
});

test("unit test: W1-T4025 adaptive follow-up does not block a healthy PR", async () => {
  const { plan, dir } = fixturePlan();
  try {
    const events: string[] = [];
    const mergedIds = new Set<string>();
    const summary = await runDrain(
      plan,
      {
        refreshMerged: () => ((id: string) => mergedIds.has(id)) as MergedSet,
        isLifetimeCapExceeded: () => true,
        onLifetimePressure: async () => {
          events.push("judge");
        },
        runOne: async (taskId) => {
          events.push(`run:${taskId}`);
          mergedIds.add(taskId);
          return okResult(taskId);
        },
      },
      { laneCount: 2, max: 2 },
    );
    assert.deepEqual(summary.merged, ["T4025-A", "T4025-B"]);
    assert.deepEqual(events, ["run:T4025-A", "judge", "run:T4025-B", "judge"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("unit test: W1-T4025 single-lane judge failure is logged after a successful dispatch", async () => {
  const { plan, dir } = fixturePlan();
  try {
    const failures: string[] = [];
    const summary = await runDrain(
      plan,
      {
        refreshMerged: () => (() => false) as MergedSet,
        isLifetimeCapExceeded: () => true,
        onLifetimePressure: async () => {
          throw new Error("judge unavailable");
        },
        runOne: async (taskId) => okResult(taskId),
        log: (step: string, extra: Record<string, unknown> = {}) => {
          if (step === "dispatch.lifetime_pressure.failed") failures.push(String(extra.error));
        },
      },
      { max: 1 },
    );
    assert.deepEqual(summary.attempted, ["T4025-A"]);
    assert.deepEqual(failures, ["Error: judge unavailable"], "the failed follow-up is visible but does not block the task");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("unit test: W1-T4025 single-lane pressure still flushes when the worker throws", async () => {
  const { plan, dir } = fixturePlan();
  try {
    let pressureCalls = 0;
    const summary = await runDrain(
      plan,
      {
        refreshMerged: () => (() => false) as MergedSet,
        isLifetimeCapExceeded: () => true,
        onLifetimePressure: async () => {
          pressureCalls++;
        },
        runOne: async () => {
          throw new Error("worker failed");
        },
      },
      { max: 1 },
    );
    assert.equal(summary.stopReason, "error");
    assert.equal(pressureCalls, 1, "pressure is flushed even on the worker-error path");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("unit test: W1-T4025 lane judge failure is logged without blocking either sibling", async () => {
  const { plan, dir } = fixturePlan();
  try {
    const failures: string[] = [];
    const mergedIds = new Set<string>();
    const summary = await runDrain(
      plan,
      {
        refreshMerged: () => (id: string) => mergedIds.has(id),
        isLifetimeCapExceeded: () => true,
        onLifetimePressure: async () => {
          throw new Error("lane judge unavailable");
        },
        runOne: async (taskId) => {
          mergedIds.add(taskId);
          return okResult(taskId);
        },
        log: (step: string, extra: Record<string, unknown> = {}) => {
          if (step === "dispatch.lifetime_pressure.failed") failures.push(String(extra.error));
        },
      },
      { laneCount: 2, max: 2 },
    );
    assert.deepEqual(summary.merged.sort(), ["T4025-A", "T4025-B"]);
    assert.deepEqual(failures, ["Error: lane judge unavailable", "Error: lane judge unavailable"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("unit test: W1-T4025 flushes pressure when every lane is deferred", async () => {
  const { plan, dir } = fixturePlan();
  try {
    const pressured: string[][] = [];
    let governorCalls = 0;
    const summary = await runDrain(
      plan,
      {
        refreshMerged: () => (() => false) as MergedSet,
        isLifetimeCapExceeded: () => true,
        onLifetimePressure: async (tasks) => {
          pressured.push(tasks.map((task) => task.id));
        },
        checkCostGovernor: () => {
          governorCalls++;
          return governorCalls === 1 ? undefined : { deferred: true, observedDayCostUsd: 206, ceilingUsd: 150 };
        },
        runOne: async (taskId) => okResult(taskId),
      },
      { laneCount: 2, max: 2 },
    );
    assert.equal(summary.stopReason, "cost_governor_deferred");
    assert.deepEqual(pressured, [["T4025-A", "T4025-B"]]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("unit test: W1-T4025 daemon wiring routes pressure after a healthy dispatch", async () => {
  const { plan, dir } = fixturePlan();
  try {
    const mergedIds = new Set<string>();
    const pressured: string[][] = [];
    const summary = await runDaemon(
      plan,
      {
        refreshMerged: () => (id: string) => mergedIds.has(id),
        isLifetimeCapExceeded: () => true,
        onLifetimePressure: async (tasks: readonly Task[]) => {
          pressured.push(tasks.map((task) => task.id));
        },
        runOne: async (taskId: string) => {
          mergedIds.add(taskId);
          return okResult(taskId);
        },
        sleep: async () => {},
      } as unknown as DaemonDeps,
      { max: 1 },
    );
    assert.deepEqual(summary.merged, ["T4025-A"]);
    assert.deepEqual(pressured, [["T4025-A", "T4025-B"]], "the selection sensor can route the bounded candidate batch");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("unit test: W1-T4025 daemon judge failure is logged without stopping dispatch", async () => {
  const { plan, dir } = fixturePlan();
  try {
    const failures: string[] = [];
    const mergedIds = new Set<string>();
    const summary = await runDaemon(
      plan,
      {
        refreshMerged: () => (id: string) => mergedIds.has(id),
        isLifetimeCapExceeded: () => true,
        onLifetimePressure: async () => {
          throw new Error("daemon judge unavailable");
        },
        runOne: async (taskId: string) => {
          mergedIds.add(taskId);
          return okResult(taskId);
        },
        sleep: async () => {},
        log: (step: string, extra: Record<string, unknown> = {}) => {
          if (step === "dispatch.lifetime_pressure.failed") failures.push(String(extra.error));
        },
      } as unknown as DaemonDeps,
      { max: 1 },
    );
    assert.deepEqual(summary.merged, ["T4025-A"]);
    assert.deepEqual(failures, ["daemon judge unavailable"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
