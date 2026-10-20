// W1-T10000 — A RUN WAITING FOR ITS CHILD'S MEMORY ADMISSION NEVER HOLDS A LATCHED RESTART. On 2026-10-17 the 04:07Z latch
// waited 32+ min on W1-T9871 and W1-T9864: both were queued in `awaitMemoryAdmission` inside `spawnRunChild`, so no child
// existed, `hasChildTask` read false, and the daemon held the restart for them as in-process work. The daemon tests drive the
// REAL runDaemon in child mode on a fake clock with an injected runOne, as W1-T9924's suite does; the spawn tests drive the
// real spawnRunChild with an injected reservation that waits on its abort signal.

import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate as flush } from "node:timers/promises";
import { after, test } from "node:test";
import { runDaemon, type DaemonDeps, type DaemonFreshness } from "#src/lib/daemon.js";
import type { LearnedReservation } from "#src/lib/host-memory-learning.js";
import { loadPlan, TaskAdmissionError, type Task } from "#src/lib/plan.js";
import * as runChild from "#src/lib/run-child.js";
import { readSpec, runDir } from "#src/lib/run-child-contract.js";
import type { RunResult } from "#src/lib/run-result.js";

const minute = 60_000;
const epoch = Date.parse("2026-10-17T04:00:00Z");
const BOUND_MS = 20 * minute;
const material: Extract<DaemonFreshness, { stale: true }> = {
  stale: true, oldSha: "a".repeat(40), newSha: "b".repeat(40),
  changes: [{ sha: "b".repeat(40), subject: "fix: update worker", files: ["src/lib/worker.ts"] }],
  staleSinceMs: epoch - 120 * minute,
};
const scratch: string[] = [];
const tmp = (label: string): string => {
  const dir = mkdtempSync(join(tmpdir(), `rmd-t10000-${label}-`));
  scratch.push(dir);
  return dir;
};
after(() => { for (const dir of scratch) rmSync(dir, { recursive: true, force: true }); });

function history(spanMin: number): string[] {
  return [0, 1, 2].flatMap((n) => [
    JSON.stringify({ ts: new Date(epoch - (300 + n) * minute).toISOString(), step: "run.start", task_class: "src", run_id: `span-${n}`, task_id: `span-${n}` }),
    JSON.stringify({ ts: new Date(epoch - (300 + n - spanMin) * minute).toISOString(), step: "verdict", run_id: `span-${n}`, verdict: "merged" }),
  ]);
}

type Row = { step: string; fields: Record<string, unknown> };
type RunOptions = Parameters<DaemonDeps["runOne"]>[1] & Record<string, unknown>;
/** How the injected runOne behaves for a task: in-process, a pending child, or a child refill that falls back. */
type Behaviour = "in-process" | "pending" | "falls-back";

async function rig(options: {
  laneCount: number; behaviour: (id: string) => Behaviour; spanMin?: number; runsAsChild?: (task: Task) => boolean; holdSweep?: boolean;
}) {
  const dir = tmp("daemon");
  const path = join(dir, "tasks.yaml");
  writeFileSync(path, "ABCD".split("").map((id) =>
    `- id: ${id}\n  title: ${id}\n  repo: remudero\n  type: implement\n  depends_on: []\n  status: queued\n  files: [src/${id}.ts]\n`).join(""));
  let now = epoch;
  let latched = false;
  const merged = new Set<string>();
  const finishers = new Map<string, (result: RunResult) => void>();
  const rejecters = new Map<string, (reason: unknown) => void>();
  const runOptions = new Map<string, RunOptions>();
  const aborted: string[] = [];
  const fallbackAnswers = new Map<string, boolean | undefined>();
  const started: string[] = [];
  const sleeps: Array<() => void> = [];
  const rows: Row[] = [];
  let done = false;
  // A held full pass keeps the restart's pre-exit pass open, so the dispatch ticker goes on reporting the wait.
  let releaseSweep!: () => void;
  const sweepHeld = new Promise<void>((resolve) => { releaseSweep = resolve; });
  const run = runDaemon(loadPlan(path), {
    now: () => new Date(now), refreshMerged: () => (id: string) => merged.has(id),
    checkFreshness: () => latched ? material : { stale: false },
    readLedgerLines: () => [],
    readRestartHistory: () => history(options.spanMin ?? 30),
    adoptRunChildren: () => [],
    ...(options.runsAsChild ? { refillRunsAsChild: options.runsAsChild } : {}),
    ...(options.holdSweep ? { sweep: () => sweepHeld } : {}),
    runOne: (id: string, opts?: RunOptions) => {
      started.push(id);
      runOptions.set(id, opts!);
      const settled = new Promise<RunResult>((resolve, reject) => { finishers.set(id, resolve); rejecters.set(id, reject); });
      const behaviour = options.behaviour(id);
      // The spawn reaches the reservation only after its engine and plan reads, so the daemon hears of it after the start.
      void flush().then(() => {
        if (behaviour === "pending") {
          (opts?.onChildPending as ((p: unknown) => void) | undefined)?.({ runId: `${id}-run`, abort: async () => {
            aborted.push(id);
            rejecters.get(id)!(new TaskAdmissionError(`task ${id}'s run child was abandoned waiting for memory admission`));
          } });
        }
        if (behaviour === "falls-back") {
          const answer = (opts?.mayRunInProcess as ((reason: string) => boolean) | undefined)?.("no current engine tree for main");
          fallbackAnswers.set(id, answer);
          if (answer === false) rejecters.get(id)!(new TaskAdmissionError(`restart latched: task ${id} cannot run in-process`));
        }
      });
      return settled;
    },
    log: (step: string, fields?: Record<string, unknown>) => rows.push({ step, fields: fields ?? {} }),
    sleep: () => new Promise<void>((resolve) => sleeps.push(resolve)),
  } as unknown as DaemonDeps, { laneCount: options.laneCount, max: 12, sweepWallClockBoundMs: BOUND_MS, freshnessMinLifetimeMs: 0 });
  void run.then(() => { done = true; }, () => { done = true; });
  for (let i = 0; i < 5; i++) await flush();
  const settleTick = async () => { sleeps.shift()?.(); for (let i = 0; i < 10; i++) await flush(); };
  const h = {
    rows, started, run, aborted, fallbackAnswers, runOptions, releaseSweep,
    done: () => done,
    find: (step: string, task?: string) => rows.filter((row) => row.step === step && (task === undefined ||
      row.fields.task === task || row.fields.next_task === task || row.fields.task_id === task)),
    at: (minutes: number) => { now = epoch + minutes * minute; },
    tick: settleTick,
    latch: async () => {
      latched = true;
      h.at(1);
      await settleTick();
      assert.ok(rows.some((row) => row.step === "daemon.freshness_decision" && row.fields.action === "restart"),
        "positive control: the restart was decided");
    },
    settle: async (id: string, minutes: number) => {
      h.at(minutes);
      merged.add(id);
      finishers.get(id)!({ taskId: id, runId: `${id}-run`, merged: true, verdict: "merged", costUsd: 0 });
      for (let i = 0; i < 10; i++) await flush();
    },
    close: async () => {
      releaseSweep();
      for (let pass = 0; pass < 100 && !done; pass++) {
        for (const [id, finish] of finishers) finish({ taskId: id, runId: `${id}-run`, merged: true, verdict: "merged", costUsd: 0 });
        for (const sleep of sleeps.splice(0)) sleep();
        await flush();
      }
    },
  };
  return h;
}

test("W1-T10000: a pending run child never holds a latched restart", async () => {
  const h = await rig({ laneCount: 1, behaviour: () => "pending" });
  try {
    assert.deepEqual(h.started, ["A"]);
    await h.latch();
    for (let i = 0; i < 20 && !h.done(); i++) await h.tick();
    assert.equal(h.done(), true, "the restart fires without waiting on a run whose child has not started");
    const summary = await h.run;
    assert.equal(summary.stopReason, "stale");
    assert.deepEqual(h.aborted, ["A"], "the restart abandons the pending wait through its abort");
    // W1-T9089: there is no latch left to hold, so no latch-cost or restart-waiting row is written at all.
    assert.equal(h.find("daemon.restart_latch_cost").length + h.find("daemon.freshness_restart_waiting").length, 0);
  } finally { await h.close(); }

  // The abandoned launch never falls back in-process: runOne's child path refuses it as a lane-local admission error.
  const { runInChildWhenOn } = await import("#src/run-task.js");
  const root = tmp("abandoned-wiring");
  const fallbackRows: string[] = [];
  const asked: string[] = [];
  const abandoned = async () => ({ started: false as const, abandoned: true as const, reason: "admission-abandoned" as const, runId: "r", waitedMs: 7 });
  await assert.rejects(runInChildWhenOn({
    taskId: "A", config: { claudeBin: "/bin/true", root, installRoot: process.cwd() } as never, repoDir: root, allowStale: true,
    options: { handOffAtPrOpen: true, pairedTrialHost: "daemon" }, planSync: async () => ({}) as never,
    log: (step) => { fallbackRows.push(step); }, mayRunInProcess: (reason) => { asked.push(reason); return true; },
  }, { readMode: () => "on", spawn: abandoned as never }), (error: unknown) => error instanceof TaskAdmissionError && /abandoned after 7 ms/.test(String(error)));
  assert.deepEqual(fallbackRows, [], "no run_child.fallback: the run does not stay in-process");
  assert.deepEqual(asked, [], "an abandoned wait is never offered the in-process fallback");
});

test("W1-T10000: a pending child admitted before the restart becomes a child", async () => {
  const h = await rig({ laneCount: 2, holdSweep: true, behaviour: (id) => id === "B" ? "pending" : "in-process" });
  try {
    assert.deepEqual(h.started, ["A", "B"]);
    await h.latch();
    for (let i = 0; i < 5; i++) await h.tick();
    assert.equal(h.done(), false, "the restart waits on A, which runs in-process");
    // B's admission comes through before the restart fires: it becomes a child the next daemon adopts.
    const child = new Promise<RunResult>(() => {});
    h.runOptions.get("B")!.onChild!({ started: true, runId: "B-run", dir: "d", pid: 1, settled: child, abort: async () => ({ signalled: false, reason: "n/a" }) } as never);
    h.releaseSweep();
    await h.settle("A", 2);
    for (let i = 0; i < 20 && !h.done(); i++) await h.tick();
    assert.equal(h.done(), true, "with A settled only a child is left, and the restart fires");
    assert.equal((await h.run).stopReason, "stale");
    assert.deepEqual(h.aborted, [], "an admitted child is released to the next daemon, never abandoned");
    assert.equal(h.find("daemon.restart_latch_cost").length, 0, "W1-T9089: A was awaited, never held out");
  } finally { await h.close(); }
});

// ── the spawn side ─────────────────────────────────────────────────────────────────────────────────

const SHA = "b".repeat(40);
const HASH = "a".repeat(64);
const TASKS = [{ id: "T-1", title: "t", repo: "remudero", depends_on: [], type: "implement", verify: "auto", status: "queued" }];

class FakeChild extends EventEmitter {
  pid: number | undefined = 424_242;
  unref(): void {}
}

function spawnFixture(label: string) {
  const root = tmp(label);
  const state = join(root, "state");
  const engine = join(state, "engines", HASH);
  mkdirSync(engine, { recursive: true });
  writeFileSync(join(engine, "engine.json"), JSON.stringify({ sha: SHA, sourceHash: HASH, builtAt: Date.now() }));
  const rows: Array<Record<string, unknown> & { step: string }> = [];
  const handle = {
    id: "reservation-1", workerClass: "implement", estimateMib: 1, estimateSource: "default",
    bindRoot: () => {}, releaseOccupancy: () => {},
  } as unknown as LearnedReservation;
  const pendings: runChild.RunChildPending[] = [];
  const input = {
    taskId: "T-1", stateRoot: state, repoDir: root, root, options: { skipGitSync: false, handOffAtPrOpen: true, pairedTrialHost: "daemon" as const },
    plan: async () => ({ plan: { tasks: TASKS } }),
    log: (step: string, extra?: Record<string, unknown>) => { rows.push({ step, ...extra }); },
    onPending: (pending: runChild.RunChildPending) => { pendings.push(pending); },
  };
  const base = { mainSha: async () => SHA, engine: { isCurrent: () => true }, spawn: () => new FakeChild() as never, watch: false, pollMs: 60_000 };
  const runsDir = join(state, "runs");
  const runDirs = (): string[] => existsSync(runsDir) ? readdirSync(runsDir) : [];
  return { state, rows, handle, pendings, input, base, runDirs };
}

async function until(what: string, ready: () => boolean): Promise<void> {
  for (let i = 0; i < 500 && !ready(); i++) await flush();
  assert.ok(ready(), `timed out waiting for ${what}`);
}

test("W1-T10000: no run directory exists while the reservation waits", async () => {
  const fx = spawnFixture("dir-after-reserve");
  let grant!: (reservation: LearnedReservation) => void;
  const asked: string[] = [];
  const launching = runChild.spawnRunChild(fx.input, { ...fx.base, reserve: (_kind, runId) => {
    asked.push(runId);
    return new Promise<LearnedReservation>((resolve) => { grant = resolve; });
  } });
  await until("the reservation wait", () => asked.length === 1);
  assert.deepEqual(fx.runDirs(), [], "a run waiting for its reservation leaves no spec-less run directory");
  assert.equal(existsSync(runDir(fx.state, asked[0]!)), false);
  assert.equal(fx.pendings.length, 1, "the daemon is told the run is pending");
  assert.equal(fx.pendings[0]!.runId, asked[0]);
  const waitingRow = fx.rows.find((row) => row.step === "run_child.admission_waiting");
  assert.equal(waitingRow?.run_id, asked[0]);
  assert.equal(typeof waitingRow?.queue_length, "number");
  grant(fx.handle);
  const launched = await launching;
  assert.ok(launched.started, JSON.stringify(launched));
  launched.settled.catch(() => {});
  launched.detach?.();
  const spec = readSpec(runDir(fx.state, asked[0]!));
  assert.ok(spec.ok, "once the reservation is held the spec is written");
  assert.equal(spec.value.reservationId, "reservation-1");
  await fx.pendings[0]!.abort(); // a late abort finds the wait already over and changes nothing
  assert.equal(fx.rows.filter((row) => row.step === "run_child.spawn_abandoned").length, 0);
});

test("W1-T10000: an abandoned admission wait keeps its queue position across the restart", async () => {
  const fx = spawnFixture("abandoned");
  let now = epoch;
  const seen: Array<{ signal: AbortSignal; sinceMs?: number }> = [];
  const waitsOnSignal = (_kind: unknown, _runId: string, admission: { signal: AbortSignal; sinceMs?: number }) => {
    seen.push(admission);
    return new Promise<LearnedReservation>((_, reject) => {
      admission.signal.addEventListener("abort", () => reject(new Error("admission-abandoned")), { once: true });
    });
  };
  const first = runChild.spawnRunChild(fx.input, { ...fx.base, clock: () => now, reserve: waitsOnSignal as never });
  await until("the first wait", () => fx.pendings.length === 1);
  now = epoch + 12 * minute;
  await fx.pendings[0]!.abort();
  const abandoned = await first;
  assert.equal(abandoned.started, false);
  assert.equal("abandoned" in abandoned && abandoned.abandoned, true, "a distinct abandoned launch, never a fallback");
  assert.equal(fx.rows.filter((row) => row.step === "run_child.fallback").length, 0);
  assert.equal(fx.rows.find((row) => row.step === "run_child.spawn_abandoned")?.waited_ms, 12 * minute);
  assert.deepEqual(fx.runDirs(), []);
  assert.equal(seen[0]!.sinceMs, undefined, "the first wait carried no earlier position");

  // The next daemon's spawn for the task queues from the abandoned wait's start, not from now.
  now = epoch + 15 * minute;
  assert.equal(runChild.readCarriedAdmissionWait(fx.state, "T-1"), epoch);
  const second = await runChild.spawnRunChild(fx.input, { ...fx.base, clock: () => now, reserve: async (_kind, _runId, admission) => {
    seen.push(admission);
    return fx.handle;
  } });
  assert.ok(second.started);
  second.settled.catch(() => {});
  second.detach?.();
  assert.equal(seen[1]!.sinceMs, epoch, "the carried wait is passed as the admission's sinceMs");
  assert.equal(fx.rows.find((row) => row.step === "run_child.admission_waiting" && row.carried_ms !== undefined)?.carried_ms, 15 * minute);
  assert.equal(runChild.readCarriedAdmissionWait(fx.state, "T-1"), undefined, "a held reservation spends the carried wait");

  // The default reservation path: an admission aborted as it begins opens no reservation and reads as abandoned too.
  const viaDefault = await runChild.spawnRunChild({ ...fx.input, onPending: (pending) => { void pending.abort(); } }, { ...fx.base });
  assert.equal("abandoned" in viaDefault && viaDefault.abandoned, true);
  // A torn carried file carries no position.
  writeFileSync(join(fx.state, runChild.RUN_CHILD_ADMISSION_WAITS_DIR, "T-1.json"), "{");
  assert.equal(runChild.readCarriedAdmissionWait(fx.state, "T-1"), undefined);

  // A reservation granted in the same moment as the abort is released, and the run is still abandoned.
  let released = 0;
  const late = { ...fx.handle, releaseOccupancy: () => { released += 1; } } as LearnedReservation;
  const racing = await runChild.spawnRunChild({ ...fx.input, onPending: (pending) => { void pending.abort(); } }, { ...fx.base,
    reserve: async () => late });
  assert.equal("abandoned" in racing && racing.abandoned, true);
  assert.equal(released, 1);
});

test("W1-T10000: a carried wait that cannot be written never fails the abandonment", async () => {
  const fx = spawnFixture("unwritable-wait");
  // A FILE where the waits directory belongs: every write under it fails, for every uid.
  writeFileSync(join(fx.state, runChild.RUN_CHILD_ADMISSION_WAITS_DIR), "not a directory");
  assert.equal(runChild.readCarriedAdmissionWait(fx.state, "T-1"), undefined);
  const abandoned = await runChild.spawnRunChild({ ...fx.input, onPending: (pending) => { void pending.abort(); } }, { ...fx.base });
  assert.equal("abandoned" in abandoned && abandoned.abandoned, true, "the wait is still abandoned, never run in-process");
  const row = fx.rows.find((r) => r.step === "run_child.spawn_abandoned");
  assert.match(String(row?.carry_error), /ENOTDIR|EEXIST/, "the row names why the wait could not be carried");
});

test("W1-T10000: a child refill that falls back in-process is judged as in-process", async () => {
  // W1-T9089: C is admitted as a child after the restart was decided; in-process it would hold the exit it skipped.
  const h = await rig({ laneCount: 2, runsAsChild: (task) => task.id === "C",
    behaviour: (id) => id === "C" ? "falls-back" : "in-process" });
  try {
    await h.latch();
    await h.settle("A", 2);
    assert.ok(h.started.includes("C"), "C refills because it runs as a child");
    assert.equal(h.find("dispatch.lane_refilled", "C")[0]?.fields.restart_decided, true);
    await until("C's fallback", () => h.fallbackAnswers.has("C"));
    assert.equal(h.fallbackAnswers.get("C"), false, "a child admitted after the decision may not run in-process");
    const held = h.find("daemon.admission_held").filter((row) => row.fields.runs_as_child === true);
    assert.equal(held.length, 1, "the refused fallback names why it was held");
    assert.equal(held[0]!.fields.task, "C");
    assert.equal(held[0]!.fields.reason, "restart decided");
    assert.equal(held[0]!.fields.fallback_reason, "no current engine tree for main");
    assert.equal(h.find("daemon.restart_yield_asked").length, 0);
  } finally { await h.close(); }

  // runOne's child path asks before it stays in-process, and a refusal ends the lane as a lane-local admission error.
  const { runInChildWhenOn } = await import("#src/run-task.js");
  const root = tmp("fallback-wiring");
  const asked: string[] = [];
  const base = {
    taskId: "C", config: { claudeBin: "/bin/true", root, installRoot: process.cwd() } as never, repoDir: root, allowStale: true,
    options: { handOffAtPrOpen: true, pairedTrialHost: "daemon" as const }, planSync: async () => ({}) as never, log: () => {},
  };
  const noEngine = async () => ({ started: false as const, reason: "no current engine tree for main" });
  const refuse = (reason: string) => { asked.push(reason); return false; };
  await assert.rejects(runInChildWhenOn({ ...base, mayRunInProcess: refuse }, { readMode: () => "on", spawn: noEngine as never }),
    (error: unknown) => error instanceof TaskAdmissionError && /restart decided/.test(String(error)));
  await assert.rejects(runInChildWhenOn({ ...base, mayRunInProcess: refuse }, { readMode: () => "shadow" }), TaskAdmissionError);
  assert.deepEqual(asked, ["no current engine tree for main", "sweep.runChild.mode is not on"]);
  assert.equal(await runInChildWhenOn({ ...base, mayRunInProcess: () => true }, { readMode: () => "on", spawn: noEngine as never }), undefined);
});

test("W1-T10000: a pending run that falls back in-process under the latch is a holdout again", async () => {
  // W1-T9089: no holdout is left; a run started before the restart may fall back in-process, and the restart awaits it.
  const h = await rig({ laneCount: 2, holdSweep: true, behaviour: (id) => id === "B" ? "pending" : "in-process" });
  try {
    await h.latch();
    const fallBack = h.runOptions.get("B")!.mayRunInProcess as (reason: string) => boolean;
    assert.equal(fallBack("the run child could not be started: spawn failed"), true, "a run started before the latch may run in-process");
    h.releaseSweep();
    await h.settle("A", 2);
    for (let i = 0; i < 5; i++) await h.tick();
    assert.equal(h.done(), false, "B is in-process work again, awaited");
    await h.settle("B", 3);
    for (let i = 0; i < 20 && !h.done(); i++) await h.tick();
    assert.equal((await h.run).stopReason, "stale");
    assert.equal(h.find("daemon.restart_holdout").length, 0);
  } finally { await h.close(); }
});
