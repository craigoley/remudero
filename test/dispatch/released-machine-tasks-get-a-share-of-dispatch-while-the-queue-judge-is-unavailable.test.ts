/**
 * W1-T12551: released machine tasks get a share of dispatch while the queue judge is unavailable.
 *
 * The queue judge was meant to move measured machine work up the queue. It has had no completed pass since
 * 2026-11-12, and garden-origin tasks were not built (ci-friction 0 of 33, scout 0 of 16 in 14 days). While the
 * judge is stale and machine starts are below the share, the eligible machine task that has waited longest sorts
 * first. The share only reorders eligible tasks.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate as flushMicrotasks } from "node:timers/promises";
import { after, test } from "node:test";

import { runDaemon, type DaemonDeps } from "#src/lib/daemon.js";
import type { DispatchScoreInputs, DispatchValueContext } from "#src/lib/dispatch-value.js";
import { appendLedger, DECISION_RELEVANT_LEDGER_STEPS, ledgerExceedsRotationCeiling, rotateLedger, type LedgerLine } from "#src/lib/ledger.js";
import {
  MACHINE_DISPATCH_SHARE, MACHINE_SHARE_STEP, QUEUE_JUDGE_STALE_MS, machineShareStarts, nextRunnable, runnableCandidates,
  type MachineShareInput, type MachineShareMove,
} from "#src/lib/drain.js";
import { MAX_RETAINED_LINES_PER_STEP } from "#src/lib/ledger.js";
import { loadPlan, type Plan, type Task } from "#src/lib/plan.js";
import { QUEUE_JUDGE_SCORECARD_STEP, queueJudgeAvailability } from "#src/lib/queue-judge-gardener.js";
import { readLedgerLines } from "#src/lib/status.js";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";

type RunResult = Awaited<ReturnType<NonNullable<DaemonDeps["runOne"]>>>;

const HOUR = 3_600_000;
const NOW = Date.parse("2026-11-13T12:00:00.000Z");
const iso = (ms: number) => new Date(ms).toISOString();

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
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}w1t12551-plan-`));
  dirs.push(dir);
  const file = join(dir, "tasks.yaml");
  writeFileSync(file, shards.join("\n") + "\n");
  return loadPlan(file);
}

const notMerged = () => false;
const ids = (tasks: readonly Task[]) => tasks.map((t) => t.id);
const operatorStarts = (n: number) => Array.from({ length: n }, (_, i) => ({ taskId: `W1-T${900 + i}`, authorClass: undefined }));

function stale(over: Partial<MachineShareInput> = {}): MachineShareInput {
  return { queueJudgeStaleMs: QUEUE_JUDGE_STALE_MS + HOUR, starts: operatorStarts(4), ...over };
}

function ages(entries: Array<[string, number]>): DispatchValueContext {
  const inputs = (filing_age_ms: number): DispatchScoreInputs => ({
    priority_head_start: 1, filing_age_ms, median_wait_ms: HOUR, urgency: 1, dependent_value: 0, starts: 0,
  });
  return {
    scoreByClass: new Map(), openDependentFanoutByTaskId: new Map(),
    costOfDelayInputsByTaskId: new Map(entries.map(([id, ms]) => [id, inputs(ms)])),
  };
}

// ── 1. availability ──────────────────────────────────────────────────────────────────────────────────────────────

test("W1-T12551 criterion 1: availability is the time since the last completed pass; an unavailable pass is not one", () => {
  const rows = [
    { ts: iso(NOW - 10 * HOUR), step: QUEUE_JUDGE_SCORECARD_STEP, asked: true },
    { ts: iso(NOW - 8 * HOUR), step: "queue_judge.unavailable", reason: "malformed judge answer", answer_chars: 0 },
    { ts: iso(NOW - HOUR), step: "queue_judge.unavailable", reason: "malformed judge answer", answer_chars: 0 },
    { ts: iso(NOW - HOUR), step: "run.start", task_id: "W1-T1" },
  ];
  assert.deepEqual(queueJudgeAvailability(rows, NOW), { lastCompletedAt: iso(NOW - 10 * HOUR), staleMs: 10 * HOUR });

  const neverCompleted = queueJudgeAvailability(rows.slice(1), NOW);
  assert.equal(neverCompleted.lastCompletedAt, undefined);
  assert.equal(neverCompleted.staleMs, 8 * HOUR, "with no completed pass, staleness runs from the first unavailable row");

  const working = queueJudgeAvailability([...rows, { ts: iso(NOW - HOUR / 2), step: QUEUE_JUDGE_SCORECARD_STEP }], NOW);
  assert.equal(working.lastCompletedAt, iso(NOW - HOUR / 2));
  assert.equal(working.staleMs, HOUR / 2, "a pass that completed half an hour ago gives half an hour");

  const quiet = queueJudgeAvailability([rows[0]!], NOW);
  assert.deepEqual(quiet, { lastCompletedAt: iso(NOW - 10 * HOUR), staleMs: 10 * HOUR },
    "with no unavailable row, a pass ten hours ago still gives ten hours");
  assert.equal(queueJudgeAvailability([], NOW).staleMs, undefined, "no rows is unknown, never stale");
});

// ── 2. the share moves the longest-waiting machine task ────────────────────────────────────────────────────────

test("W1-T12551 criterion 2: a stale judge and machine starts below the share put the longest-waiting machine task first", () => {
  const plan = planOf(
    shard("W1-T1"), shard("W1-T2"),
    shard("W1-T40", { machine: true, priority: 3 }), shard("W1-T50", { machine: true, priority: 3 }),
  );
  const moved: Array<[string, MachineShareMove]> = [];
  const machineShare = stale({ onMoved: (task, move) => moved.push([task.id, move]) });
  assert.equal(nextRunnable(plan, notMerged)?.id, "W1-T1", "without the share an operator task leads");
  assert.equal(nextRunnable(plan, notMerged, { machineShare })?.id, "W1-T40", "with no ages, the oldest id has waited longest");
  assert.equal(moved[0]?.[0], "W1-T40");
  assert.deepEqual(moved[0]?.[1], { share: MACHINE_DISPATCH_SHARE, machine_starts: 0, starts: 4, queue_judge_stale_ms: QUEUE_JUDGE_STALE_MS + HOUR });

  const context = ages([["W1-T1", HOUR], ["W1-T2", HOUR], ["W1-T40", 2 * HOUR], ["W1-T50", 30 * HOUR]]);
  assert.deepEqual(ids(runnableCandidates(plan, notMerged, 4, { machineShare, dispatchValueContext: context })).slice(0, 1), ["W1-T50"],
    "the measured filing age names the task that has waited longest");

  const oneMachineOfFive = [...operatorStarts(4), { taskId: "W1-T40", authorClass: "machine" }];
  assert.equal(nextRunnable(plan, notMerged, { machineShare: stale({ starts: oneMachineOfFive }) })?.id, "W1-T40", "1 of 5 is below the share");
  assert.equal(nextRunnable(plan, notMerged, { machineShare: stale({ starts: [] }) })?.id, "W1-T40", "no starts is below the share");
});

// ── 3. otherwise the order is unchanged ─────────────────────────────────────────────────────────────────────────

test("W1-T12551 criterion 3: with the judge available, or machine starts at the share, the order is today's", () => {
  const plan = planOf(shard("W1-T1"), shard("W1-T2", { priority: 2 }), shard("W1-T40", { machine: true, priority: 3 }));
  const today = ids(runnableCandidates(plan, notMerged, 3));
  assert.deepEqual(today, ["W1-T1", "W1-T2", "W1-T40"]);
  const machineAtShare = [...operatorStarts(3), { taskId: "W1-T40", authorClass: "machine" }];
  for (const machineShare of [
    stale({ queueJudgeStaleMs: undefined }),
    stale({ queueJudgeStaleMs: HOUR }),
    stale({ queueJudgeStaleMs: QUEUE_JUDGE_STALE_MS }),
    stale({ starts: machineAtShare }),
  ]) {
    let moves = 0;
    const share = { ...machineShare, onMoved: () => { moves++; } };
    assert.deepEqual(ids(runnableCandidates(plan, notMerged, 3, { machineShare: share })), today);
    assert.equal(nextRunnable(plan, notMerged, { machineShare: share })?.id, "W1-T1");
    assert.equal(moves, 0);
  }
  assert.deepEqual(ids(runnableCandidates(plan, notMerged, 3, { machineShare: stale({ starts: undefined }) })), today,
    "starts the rows may not hold in full leave today's order");

  // Rotation keeps the newest MAX_RETAINED_LINES_PER_STEP starts: 100 machine starts then 200 operator starts in the
  // window leave 200 operator rows. The share is then unknown, so the order stays today's.
  const startRow = (i: number, taskId: string) => ({ ts: iso(NOW - 20 * HOUR + i * 60_000), step: "run.start", task_id: taskId });
  const machinePlan = planOf(shard("W1-T1"), shard("W1-T40", { machine: true, priority: 3 }));
  const full = [...Array.from({ length: 100 }, (_, i) => startRow(i, "W1-T40")), ...Array.from({ length: 200 }, (_, i) => startRow(100 + i, "W1-T1"))];
  const older = { ts: iso(NOW - 30 * HOUR), step: "run.start", task_id: "W1-T1" };
  assert.equal(machineShareStarts([older, ...full], machinePlan.byId, NOW)?.filter((s) => s.authorClass === "machine").length, 100,
    "with a start older than the window, every start in it is counted");
  const retained = full.slice(-MAX_RETAINED_LINES_PER_STEP);
  assert.equal(machineShareStarts(retained, machinePlan.byId, NOW), undefined, "a capped window is not counted as 0% machine");
  assert.equal(nextRunnable(machinePlan, notMerged, { machineShare: stale({ starts: machineShareStarts(retained, machinePlan.byId, NOW) }) })?.id, "W1-T1");
  const reachesBack = [older, ...retained.slice(1)];
  assert.equal(machineShareStarts(reachesBack, machinePlan.byId, NOW)?.length, MAX_RETAINED_LINES_PER_STEP - 1,
    "a start older than the window shows the window is held in full");
});

// ── 4. invariant: the share never grants eligibility ───────────────────────────────────────────────────────────

test("W1-T12551 criterion 4: the share never moves a held, blocked, verify-human or waiting task, and resumable work stays first", () => {
  const plan = planOf(
    shard("W1-T1"), shard("W1-T2"),
    shard("W1-T41", { machine: true, hold: true }), shard("W1-T42", { machine: true, status: "blocked" }),
    shard("W1-T43", { machine: true, verify: "human" }), shard("W1-T44", { machine: true, dependsOn: ["W1-T2"] }),
  );
  const ineligible = ["W1-T41", "W1-T42", "W1-T43", "W1-T44"];
  const picked = ids(runnableCandidates(plan, notMerged, 6, { machineShare: stale() }));
  assert.deepEqual(picked, ["W1-T1", "W1-T2"]);
  for (const id of ineligible) assert.ok(!picked.includes(id), `${id} is not made eligible`);

  const withReady = planOf(shard("W1-T1"), shard("W1-T2"), shard("W1-T40", { machine: true, priority: 3 }));
  const resumableTaskIds = new Set(["W1-T2"]);
  assert.deepEqual(ids(runnableCandidates(withReady, notMerged, 3, { machineShare: stale(), resumableTaskIds })),
    ["W1-T2", "W1-T40", "W1-T1"], "a resumable task still sorts first; the machine task sorts next");
});

// ── 5. the daemon's dispatch pass ───────────────────────────────────────────────────────────────────────────────

test("W1-T12551 criterion 5: the daemon gives the selector the judge's staleness and the trailing starts, and logs the move", async () => {
  const plan = planOf(shard("W1-T1"), shard("W1-T40", { machine: true, priority: 3 }));
  const ledger = [
    { ts: iso(NOW - 30 * HOUR), step: QUEUE_JUDGE_SCORECARD_STEP, asked: true },
    { ts: iso(NOW - 20 * HOUR), step: "queue_judge.unavailable", answer_chars: 0 },
    { ts: iso(NOW - 3 * HOUR), step: "run.start", task_id: "W1-T7" },
    { ts: iso(NOW - 2 * HOUR), step: "run.start", task_id: "W1-T8" },
    { ts: iso(NOW - 48 * HOUR), step: "run.start", task_id: "W1-T40" },
  ].map((row) => JSON.stringify(row));
  const drive = async (lines: readonly string[]) => {
    const spawned: string[] = [];
    const rows: Array<{ step: string; extra: Record<string, unknown> }> = [];
    let polls = 0;
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

  const unavailable = await drive(ledger);
  assert.deepEqual(unavailable.spawned, ["W1-T40"], "the daemon dispatches the released machine task first");
  assert.equal(unavailable.moves.length, 1);
  assert.deepEqual(unavailable.moves[0], {
    task_id: "W1-T40", share: MACHINE_DISPATCH_SHARE, machine_starts: 0, starts: 2, queue_judge_stale_ms: 30 * HOUR,
  }, "the 48-hour-old start is outside the trailing 24 hours");

  const available = await drive([...ledger, JSON.stringify({ ts: iso(NOW - HOUR), step: QUEUE_JUDGE_SCORECARD_STEP })]);
  assert.deepEqual(available.spawned, ["W1-T1"], "a working judge leaves today's order");
  assert.equal(available.moves.length, 0);

  const capped = Array.from({ length: MAX_RETAINED_LINES_PER_STEP }, (_, i) =>
    JSON.stringify({ ts: iso(NOW - 10 * HOUR + i * 60_000), step: "run.start", task_id: "W1-T7" }));
  const unknownShare = await drive([...ledger.slice(0, 2), ...capped]);
  assert.deepEqual(unknownShare.spawned, ["W1-T1"], "a capped start window leaves today's order");
  assert.equal(unknownShare.moves.length, 0);

  const starts = machineShareStarts(ledger.map((line) => JSON.parse(line) as Record<string, unknown>), plan.byId, NOW);
  assert.deepEqual(starts, [
    { taskId: "W1-T7", authorClass: undefined, atMs: NOW - 3 * HOUR },
    { taskId: "W1-T8", authorClass: undefined, atMs: NOW - 2 * HOUR },
  ]);
});

test("W1-T12551 falsifier: queue-judge history survives real rotation and refills use starts admitted this tick", async () => {
  assert.ok(DECISION_RELEVANT_LEDGER_STEPS.has(QUEUE_JUDGE_SCORECARD_STEP));
  assert.ok(DECISION_RELEVANT_LEDGER_STEPS.has("queue_judge.unavailable"));

  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}w1t12551-rotation-`));
  dirs.push(dir);
  const ledgerPath = join(dir, "ledger.ndjson");
  appendLedger(ledgerPath, { run_id: "score", task_id: "W1-T12551", step: QUEUE_JUDGE_SCORECARD_STEP,
    ts: iso(NOW - 30 * HOUR) } as LedgerLine, { ceilingBytes: Number.MAX_SAFE_INTEGER });
  appendLedger(ledgerPath, { run_id: "unavailable", task_id: "W1-T12551", step: "queue_judge.unavailable",
    ts: iso(NOW - 20 * HOUR) } as LedgerLine, { ceilingBytes: Number.MAX_SAFE_INTEGER });
  for (let n = 0; n < 300; n++) writeFileSync(ledgerPath, `${JSON.stringify({ step: "rotation-noise", marker: "x".repeat(100) })}\n`, { flag: "a" });
  assert.ok(ledgerExceedsRotationCeiling(ledgerPath, 2_000));
  assert.equal(rotateLedger(ledgerPath, { ceilingBytes: 2_000 }).rotated, true);
  const retained = readLedgerLines(ledgerPath);
  assert.equal(queueJudgeAvailability(retained, NOW).staleMs, 30 * HOUR,
    "the live-only daemon input still has the last completed pass and later unavailable row after rotation");

  const plan = planOf(
    shard("W1-T1"), shard("W1-T2", { priority: 2 }),
    shard("W1-T40", { machine: true, priority: 3 }), shard("W1-T50", { machine: true, priority: 3 }),
  );
  const lines = [
    { ts: iso(NOW - 30 * HOUR), step: QUEUE_JUDGE_SCORECARD_STEP, task_id: "W1-T90" },
    { ts: iso(NOW - 20 * HOUR), step: "queue_judge.unavailable", task_id: "W1-T90" },
    { ts: iso(NOW - 3 * HOUR), step: "run.start", task_id: "W1-T7" },
    { ts: iso(NOW - 2 * HOUR), step: "run.start", task_id: "W1-T8" },
  ].map((row) => JSON.stringify(row));
  const spawned: string[] = [];
  const events: Array<{ step: string; extra: Record<string, unknown> }> = [];
  let releaseSlowLane: (() => void) | undefined;
  const slowLane = new Promise<void>((resolve) => { releaseSlowLane = resolve; });
  let polls = 0;
  await runDaemon(plan, {
    refreshMerged: () => () => false,
    runOne: async (id) => {
      spawned.push(id);
      if (id === "W1-T40") await slowLane;
      return { taskId: id, runId: `${id}-run`, merged: true, costUsd: 0, verdict: "merged" };
    },
    sleep: async () => {},
    checkStop: () => (++polls > 100 ? "test stop" : undefined),
    log: (step, extra = {}) => {
      events.push({ step, extra });
      if (step.startsWith("dispatch.lane_refill")) releaseSlowLane?.();
    },
    now: () => new Date(NOW),
    readLedgerLines: () => lines,
  } as DaemonDeps, { headroomEnabled: false, laneCount: 2, max: 3 });
  assert.deepEqual(spawned, ["W1-T40", "W1-T1", "W1-T2"],
    `at one machine start of four, the refill returns to ordinary dispatch order instead of promoting W1-T50; events=${JSON.stringify(events.filter((e) => e.step.startsWith("dispatch.lane_refill") || e.step === MACHINE_SHARE_STEP))}`);
});

test("W1-T12551 criterion 5, with W1-T12551 criterion 3 on refill: a lane refill counts the starts this pass made", async () => {
  // Two operator starts in the trailing day and a stale judge: the tick moves W1-T40 up and starts it with W1-T1.
  // That makes 1 machine start of 4, which is the share, so the refill must keep today's order and start W1-T2.
  const plan = planOf(shard("W1-T1"), shard("W1-T2"), shard("W1-T40", { machine: true, priority: 3 }), shard("W1-T50", { machine: true, priority: 3 }));
  const lines = [
    { ts: iso(NOW - 30 * HOUR), step: QUEUE_JUDGE_SCORECARD_STEP, asked: true },
    { ts: iso(NOW - 3 * HOUR), step: "run.start", task_id: "W1-T7" },
    { ts: iso(NOW - 2 * HOUR), step: "run.start", task_id: "W1-T8" },
  ].map((row) => JSON.stringify(row));
  const releases = new Map<string, (r: RunResult) => void>();
  const spawned: string[] = [];
  const rows: Array<{ step: string; extra: Record<string, unknown> }> = [];
  const merged = new Set<string>();
  let stopping = false;
  const result = (id: string): RunResult => ({ taskId: id, runId: `${id}-run`, merged: true, costUsd: 0, verdict: "merged" }) as RunResult;
  const run = runDaemon(plan, {
    refreshMerged: () => (id: string) => merged.has(id),
    runOne: (id) => {
      spawned.push(id);
      return stopping ? Promise.resolve(result(id)) : new Promise<RunResult>((done) => releases.set(id, done));
    },
    sleep: async () => {},
    checkStop: () => (stopping ? "test stop" : undefined),
    log: (step, extra = {}) => rows.push({ step, extra }),
    now: () => new Date(NOW),
    readLedgerLines: () => lines,
  } as DaemonDeps, { headroomEnabled: false, laneCount: 2, max: 3 });
  const settle = async (id: string) => {
    merged.add(id);
    releases.get(id)?.(result(id));
    for (let i = 0; i < 10; i++) await flushMicrotasks();
  };
  try {
    for (let i = 0; i < 5; i++) await flushMicrotasks();
    assert.deepEqual(spawned, ["W1-T40", "W1-T1"], "the tick moves the machine task up and fills both lanes");
    await settle("W1-T1");
    assert.deepEqual(spawned, ["W1-T40", "W1-T1", "W1-T2"], "at the share, the refill starts today's next task, not W1-T50");
    const moves = rows.filter((r) => r.step === MACHINE_SHARE_STEP).map((r) => r.extra);
    assert.deepEqual(moves, [{
      task_id: "W1-T40", share: MACHINE_DISPATCH_SHARE, machine_starts: 0, starts: 2, queue_judge_stale_ms: 30 * HOUR,
    }], "only the tick's move is logged, with the counts it was decided on");
  } finally {
    stopping = true;
    for (const [id, done] of releases) done(result(id));
    await run;
  }
});
