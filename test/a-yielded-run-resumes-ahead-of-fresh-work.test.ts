// 2026-10-17: W1-T9089 and W1-T9757 yielded to a restart at 22:07Z and 22:09Z, before either opened a pull request.
// Their receipts stayed pending and their run branches were released, but the cost-of-delay stride order put them at
// ranks 28 and 31, behind a high-fanout family filed at 18:17Z. With three lanes and few refills, neither had a
// run.start for 6.8 h. A harness yield is the harness's own preemption: the task already won a lane, so it resumes
// ahead of fresh work.
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate as flush } from "node:timers/promises";
import { test } from "node:test";
import { runDaemon, type DaemonDeps } from "../src/lib/daemon.js";
import { dispatchOrder, nextRunnable } from "../src/lib/drain.js";
import { loadPlan, loadPlanFromYaml, type Task } from "../src/lib/plan.js";
import type { RunResult } from "../src/run-task.js";

const head = "a".repeat(40);

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

const yaml = (rows: Array<{ id: string; priority?: number; deps?: string[] }>) => rows.map(({ id, priority, deps }) =>
  `- id: ${id}\n  title: ${id}\n  repo: remudero\n  type: implement\n  verify: auto\n  depends_on: [${(deps ?? []).join(", ")}]\n` +
  `  status: queued\n${priority === undefined ? "" : `  priority: ${priority}\n`}  files: [src/${id}.ts]\n`).join("");

test("a task the harness yielded before its pull request is walked ahead of every fresh start", () => {
  const plan = loadPlanFromYaml(yaml([{ id: "FRESH", priority: 1 }, { id: "OTHER", priority: 2 }, { id: "YIELDED", priority: 3 },
    { id: "WAITS", priority: 1, deps: ["FRESH"] }]), "fixture");
  // The ready cost-of-delay order of 2026-10-17: the yielded task's stride pass is the worst on the board.
  const context = {
    scoreByClass: new Map<string, number>(), openDependentFanoutByTaskId: new Map<string, number>(),
    stridePassByTaskId: new Map([["FRESH", 0.27], ["OTHER", 0.88], ["YIELDED", 2.02], ["WAITS", 0.1]]),
  };
  const ids = (tasks: Task[]) => tasks.map((t) => t.id);
  assert.deepEqual(ids(dispatchOrder(plan.tasks, context)), ["WAITS", "FRESH", "OTHER", "YIELDED"], "control: stride order alone");
  const resumable = new Set(["YIELDED", "WAITS"]);
  assert.deepEqual(ids(dispatchOrder(plan.tasks, context, resumable)), ["WAITS", "YIELDED", "FRESH", "OTHER"]);
  const merged = () => false;
  assert.equal(nextRunnable(plan, merged, { dispatchValueContext: context })?.id, "FRESH", "control: no receipt, no precedence");
  // WAITS is ordered first but its dependency is unmerged: precedence never bypasses eligibility.
  assert.equal(nextRunnable(plan, merged, { dispatchValueContext: context, resumableTaskIds: resumable })?.id, "YIELDED");
});

test("the daemon dispatches a task holding a pre-PR handoff receipt before fresh work, and names the resume", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rmd-resume-first-"));
  const path = join(dir, "tasks.yaml");
  const ids = ["A", "B", "C", "D", "E", "F"];
  writeFileSync(path, yaml(ids.map((id) => ({ id }))));
  const releases = new Map(ids.map((id) => [id, deferred<RunResult>()]));
  const started: string[] = [];
  const rows: Array<{ step: string; extra?: Record<string, unknown> }> = [];
  const sleeps: Array<ReturnType<typeof deferred<void>>> = [];
  let stopping = false;
  const receipt = JSON.stringify({ step: "run.freshness_handoff", task_id: "F", run_id: "F-1", waiting_on: "worker_round",
    branch: "run-F-123", head_sha: head });
  const run = runDaemon(loadPlan(path), {
    now: () => new Date(),
    readLedgerLines: () => [receipt],
    readPushedRunBranches: () => `${head}\trefs/heads/run-F-123\n`,
    refreshMerged: () => () => false,
    checkFreshness: () => ({ stale: false }),
    checkStop: () => stopping ? "cleanup" : undefined,
    log: (step, extra) => rows.push({ step, extra }),
    runOne: (id) => { started.push(id); return releases.get(id)!.promise; },
    sleep: () => { const sleep = deferred<void>(); sleeps.push(sleep); return sleep.promise; },
  } as DaemonDeps, { laneCount: 3, max: 6 });
  try {
    await flush();
    assert.deepEqual(started, ["F", "A", "B"]);
    const iteration = rows.find(({ step, extra }) => step === "daemon.iteration" && extra?.task === "F");
    assert.equal(iteration?.extra?.resumes_handoff, "run-F-123");
    assert.equal(rows.find(({ step, extra }) => step === "daemon.iteration" && extra?.task === "A")?.extra?.resumes_handoff, undefined);
  } finally {
    stopping = true;
    for (const [id, release] of releases) release.resolve({ taskId: id, runId: id, merged: true, verdict: "merged", costUsd: 0 });
    for (const sleep of sleeps) sleep.resolve();
    await run;
  }
});
