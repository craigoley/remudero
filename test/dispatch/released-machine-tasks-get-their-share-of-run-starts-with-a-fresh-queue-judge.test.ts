/**
 * W1-T12835: released machine tasks get their one-in-four share of run starts whether or not the queue judge is stale.
 *
 * W1-T12551 applied the share only while the queue judge was stale, so with a healthy judge machine filings, priced
 * into the 1-to-4 band, were built only when nothing operator-filed was runnable. Operator ruling 2026-11-15:
 * "Always reserve 1 in 4". The share now applies whenever the start evidence is complete, and its move row says
 * whether the judge was fresh so the share's use under a healthy judge can be counted.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import { runDaemon, type DaemonDeps } from "#src/lib/daemon.js";
import {
  MACHINE_DISPATCH_SHARE, MACHINE_SHARE_STEP, QUEUE_JUDGE_STALE_MS, nextRunnable, runnableCandidates,
  type MachineShareInput, type MachineShareMove,
} from "#src/lib/drain.js";
import { loadPlan, type Plan, type Task } from "#src/lib/plan.js";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";

const HOUR = 3_600_000;
const NOW = Date.parse("2026-11-16T12:00:00.000Z");
const iso = (ms: number) => new Date(ms).toISOString();
/** The queue judge's completed-pass row, which the daemon reads for its staleness. */
const QUEUE_JUDGE_SCORECARD_STEP = "queue_judge.scorecard";

function shard(id: string, over: { machine?: boolean; priority?: number; verify?: string; status?: string; dependsOn?: string[]; hold?: boolean } = {}): string {
  return [
    `- id: ${id}`,
    `  title: ${id}`,
    "  repo: remudero",
    "  type: implement",
    `  priority: ${over.priority ?? 1}`,
    `  depends_on: [${(over.dependsOn ?? []).join(", ")}]`,
    `  verify: ${over.verify ?? "auto"}`,
    `  status: ${over.status ?? "queued"}`,
    `  files: [src/${id}.ts]`,
    ...(over.machine ? ["  author_class: machine"] : []),
    ...(over.hold ? ["  dispatch_hold: true"] : []),
  ].join("\n");
}

const dirs: string[] = [];
after(() => { for (const dir of dirs) rmSync(dir, { recursive: true, force: true }); });

function planOf(...shards: string[]): Plan {
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}w1t12835-plan-`));
  dirs.push(dir);
  const file = join(dir, "tasks.yaml");
  writeFileSync(file, shards.join("\n") + "\n");
  return loadPlan(file);
}

const notMerged = () => false;
const ids = (tasks: readonly Task[]) => tasks.map((t) => t.id);
const operatorStarts = (n: number) => Array.from({ length: n }, (_, i) => ({ taskId: `W1-T${900 + i}`, authorClass: undefined }));
const machineStart = { taskId: "W1-T40", authorClass: "machine" };

function fresh(over: Partial<MachineShareInput> = {}): MachineShareInput {
  return { queueJudgeStaleMs: HOUR, starts: operatorStarts(4), ...over };
}

test("W1-T12835 criterion 1: a fresh queue judge and complete start evidence put a released machine task first", () => {
  const plan = planOf(shard("W1-T1"), shard("W1-T2"), shard("W1-T40", { machine: true, priority: 3 }), shard("W1-T50", { machine: true, priority: 3 }));
  assert.equal(nextRunnable(plan, notMerged)?.id, "W1-T1", "without the share an operator task leads");
  for (const queueJudgeStaleMs of [undefined, 0, HOUR, QUEUE_JUDGE_STALE_MS - 1, QUEUE_JUDGE_STALE_MS]) {
    const moved: Array<[string, MachineShareMove]> = [];
    const machineShare = fresh({ queueJudgeStaleMs, onMoved: (task, move) => moved.push([task.id, move]) });
    assert.equal(nextRunnable(plan, notMerged, { machineShare })?.id, "W1-T40", `judge staleness ${queueJudgeStaleMs} still applies the share`);
    assert.deepEqual(ids(runnableCandidates(plan, notMerged, 4, { machineShare })), ["W1-T40", "W1-T1", "W1-T2", "W1-T50"]);
    assert.equal(moved[0]?.[0], "W1-T40");
    assert.equal(moved[0]?.[1].queue_judge_fresh, true);
  }
  const belowShare = [...operatorStarts(4), machineStart];
  assert.equal(nextRunnable(plan, notMerged, { machineShare: fresh({ starts: belowShare }) })?.id, "W1-T40", "1 of 5 is below the share");
  assert.equal(nextRunnable(plan, notMerged, { machineShare: fresh({ starts: [] }) })?.id, "W1-T40", "no starts is below the share");
});

test("W1-T12835 criterion 2: invariant the-share-never-grants-eligibility, the share only reorders the eligible list", () => {
  const plan = planOf(
    shard("W1-T1"), shard("W1-T2"),
    shard("W1-T41", { machine: true, hold: true }), shard("W1-T42", { machine: true, status: "blocked" }),
    shard("W1-T43", { machine: true, verify: "human" }), shard("W1-T44", { machine: true, dependsOn: ["W1-T2"] }),
  );
  const picked = ids(runnableCandidates(plan, notMerged, 6, { machineShare: fresh() }));
  assert.deepEqual(picked, ["W1-T1", "W1-T2"], "no ineligible machine task is returned");
  assert.equal(nextRunnable(plan, notMerged, { machineShare: fresh() })?.id, "W1-T1");

  const withReady = planOf(shard("W1-T1"), shard("W1-T2"), shard("W1-T40", { machine: true, priority: 3 }));
  assert.deepEqual(ids(runnableCandidates(withReady, notMerged, 3, { machineShare: fresh(), resumableTaskIds: new Set(["W1-T2"]) })),
    ["W1-T2", "W1-T40", "W1-T1"], "a resumable task keeps its lead; the machine task sorts next");

  const today = ids(runnableCandidates(withReady, notMerged, 3));
  let moves = 0;
  const atShare = fresh({ starts: [...operatorStarts(3), machineStart], onMoved: () => { moves++; } });
  assert.deepEqual(ids(runnableCandidates(withReady, notMerged, 3, { machineShare: atShare })), today, "machine starts at the share leave the order");
  const aboveShare = fresh({ starts: [...operatorStarts(1), machineStart], onMoved: () => { moves++; } });
  assert.deepEqual(ids(runnableCandidates(withReady, notMerged, 3, { machineShare: aboveShare })), today, "above the share too");
  assert.equal(moves, 0);
});

test("W1-T12835 criterion 3: with incomplete start evidence the share is not applied", () => {
  const plan = planOf(shard("W1-T1"), shard("W1-T2", { priority: 2 }), shard("W1-T40", { machine: true, priority: 3 }));
  const today = ids(runnableCandidates(plan, notMerged, 3));
  assert.deepEqual(today, ["W1-T1", "W1-T2", "W1-T40"]);
  for (const queueJudgeStaleMs of [undefined, HOUR, QUEUE_JUDGE_STALE_MS + HOUR]) {
    let moves = 0;
    const machineShare = fresh({ queueJudgeStaleMs, starts: undefined, onMoved: () => { moves++; } });
    assert.deepEqual(ids(runnableCandidates(plan, notMerged, 3, { machineShare })), today);
    assert.equal(nextRunnable(plan, notMerged, { machineShare })?.id, "W1-T1");
    assert.equal(moves, 0);
  }
});

test("W1-T12835 criterion 4: the dispatch.machine_share row carries queue_judge_fresh", async () => {
  const move = (queueJudgeStaleMs: number | undefined) => {
    const moved: MachineShareMove[] = [];
    nextRunnable(planOf(shard("W1-T1"), shard("W1-T40", { machine: true, priority: 3 })), notMerged,
      { machineShare: fresh({ queueJudgeStaleMs, onMoved: (_task, m) => moved.push(m) }) });
    return moved[0];
  };
  assert.deepEqual(move(HOUR), { share: MACHINE_DISPATCH_SHARE, machine_starts: 0, starts: 4, queue_judge_fresh: true, queue_judge_stale_ms: HOUR });
  assert.deepEqual(move(QUEUE_JUDGE_STALE_MS + HOUR),
    { share: MACHINE_DISPATCH_SHARE, machine_starts: 0, starts: 4, queue_judge_fresh: false, queue_judge_stale_ms: QUEUE_JUDGE_STALE_MS + HOUR });
  assert.deepEqual(move(undefined), { share: MACHINE_DISPATCH_SHARE, machine_starts: 0, starts: 4, queue_judge_fresh: true },
    "an unknown staleness is never stale, and no stale_ms is invented");

  const plan = planOf(shard("W1-T1"), shard("W1-T40", { machine: true, priority: 3 }));
  const drive = async (judgeAgoMs: number) => {
    const spawned: string[] = [];
    const rows: Array<{ step: string; extra: Record<string, unknown> }> = [];
    let polls = 0;
    const lines = [
      { ts: iso(NOW - judgeAgoMs), step: QUEUE_JUDGE_SCORECARD_STEP, asked: true },
      { ts: iso(NOW - 3 * HOUR), step: "run.start", task_id: "W1-T7" },
      { ts: iso(NOW - 2 * HOUR), step: "run.start", task_id: "W1-T8" },
    ].map((row) => JSON.stringify(row));
    await runDaemon(plan, {
      refreshMerged: () => () => false,
      runOne: async (id) => { spawned.push(id); return { taskId: id, runId: `${id}-run`, merged: true, costUsd: 0, verdict: "merged" }; },
      sleep: async () => {},
      checkStop: () => (++polls > 3 ? "test stop" : undefined),
      log: (step, extra = {}) => rows.push({ step, extra }),
      now: () => new Date(NOW),
      readLedgerLines: () => lines,
    } as DaemonDeps, { headroomEnabled: false, max: 1 });
    return { spawned, moves: rows.filter((r) => r.step === MACHINE_SHARE_STEP).map((r) => r.extra) };
  };
  const healthy = await drive(HOUR);
  assert.deepEqual(healthy.spawned, ["W1-T40"], "a healthy judge no longer holds the share back");
  assert.deepEqual(healthy.moves, [{
    task_id: "W1-T40", share: MACHINE_DISPATCH_SHARE, machine_starts: 0, starts: 2, queue_judge_fresh: true, queue_judge_stale_ms: HOUR,
  }]);
  const staleJudge = await drive(30 * HOUR);
  assert.deepEqual(staleJudge.spawned, ["W1-T40"]);
  assert.deepEqual(staleJudge.moves, [{
    task_id: "W1-T40", share: MACHINE_DISPATCH_SHARE, machine_starts: 0, starts: 2, queue_judge_fresh: false, queue_judge_stale_ms: 30 * HOUR,
  }]);
});
