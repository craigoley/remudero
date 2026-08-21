import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadPlan, type Plan } from "../src/lib/plan.js";
import { runDaemon, type DaemonDeps } from "../src/lib/daemon.js";
import { pauseDetail, requestPause, requestStop, stopDetail } from "../src/lib/fleet-control.js";
import type { RunResult } from "../src/run-task.js";

// W1-T1065 — THE OPERATOR'S ONLY STOP CONTROL IS READ ONCE PER TICK AND ADMISSION HAPPENS
// MINUTES LATER IN THE SAME TICK. `deps.checkPause`/`deps.checkStop` were each consulted
// EXACTLY ONCE, at the top of `runDaemon`'s loop — with `deps.checkFreshness`, the full
// `await deps.sweep()` reconciler, `await deps.sweepOrphans()`, `await deps.sweepFeedbackLanding()`
// and `await deps.readUsage()` all sitting, awaited and unbounded, between that read and the
// first `daemon.iteration` row. A hold created in that window dispatched anyway — MEASURED on
// the live ledger: a `state/PAUSE` created 4.5 minutes before an admitted batch's own
// `daemon.iteration` timestamp. These tests exercise the fix (a re-check immediately before
// admission, for BOTH stop and pause) directly, in a file separate from `test/daemon.test.ts`
// per this shard's own note (that file already carries 83 `runDaemon` references and this repo
// has measured file-level crashes under coverage instrumentation in large shared test files).

// A minimal plan: A (independent) -> B (depends on A). Enough to prove "a task that WOULD have
// been admitted this tick was not", without any of `test/daemon.test.ts`'s wider fixture.
const YAML = `
- id: A
  title: a
  repo: remudero
  type: implement
  depends_on: []
  status: queued
- id: B
  title: b
  repo: remudero
  type: implement
  depends_on: [A]
  status: queued
`;

function fixturePlan(): Plan {
  const dir = mkdtempSync(join(tmpdir(), "daemon-pause-before-admission-"));
  const f = join(dir, "tasks.yaml");
  writeFileSync(f, YAML);
  return loadPlan(f);
}

const okResult = (id: string): RunResult => ({
  taskId: id,
  runId: id + "-run",
  merged: true,
  costUsd: 0.5,
  verdict: "merged",
});

test("daemon pause: a pause created during the sweep window is honoured before admission", async () => {
  const plan = fixturePlan();
  const root = mkdtempSync(join(tmpdir(), "daemon-pause-recheck-sweep-"));
  const lines: Array<{ step: string; extra: Record<string, unknown> }> = [];
  let sweepCalls = 0;
  let sleeps = 0;
  const sleep: DaemonDeps["sleep"] = async () => {
    sleeps++;
    // Ends the test once the re-check has had a chance to idle-poll a few times —
    // never clears the pause, so a stray admission after this point would still surface.
    if (sleeps >= 3) requestStop(root, "test done polling — pause never cleared");
  };
  const s = await runDaemon(plan, {
    refreshMerged: () => () => false,
    runOne: async (id) => {
      throw new Error(
        `runOne must never be called for ${id} — the pause created during the sweep window ` +
          "must be honoured before admission, not after",
      );
    },
    // The awaited, unbounded hook this task's rationale names directly: the operator's hold
    // appears WHILE this is still running, well after the top-of-tick checkPause already read
    // undefined.
    sweep: async () => {
      sweepCalls++;
      requestPause(root, "operator hold created mid-sweep");
    },
    checkStop: () => stopDetail(root),
    checkPause: () => pauseDetail(root),
    sleep,
    log: (step, extra = {}) => lines.push({ step, extra }),
  });
  assert.equal(s.stopReason, "stopped");
  assert.ok(sweepCalls >= 1, "the sweep actually ran (the window this task closes)");
  assert.deepEqual(
    s.attempted,
    [],
    "no task was ever admitted — the pause created mid-sweep was honoured before admission",
  );
  assert.ok(
    lines.some((l) => l.step === "daemon.pause" && /mid-sweep/.test(String(l.extra.detail))),
    "a daemon.pause row, carrying the SAME detail the existing control already produces, was logged for the re-check",
  );
});

test("daemon pause: the re-check runs after the sweep and before the first iteration row", async () => {
  const plan = fixturePlan();
  const root = mkdtempSync(join(tmpdir(), "daemon-pause-recheck-order-"));
  const order: string[] = [];
  let dispatchCount = 0;
  const s = await runDaemon(plan, {
    refreshMerged: () => () => false,
    runOne: async (id) => {
      dispatchCount++;
      order.push(`runOne:${id}`);
      return okResult(id);
    },
    sweep: async () => {
      order.push("sweep");
    },
    // Trips AFTER the one dispatch this test lets through — never during it — so exactly one
    // admission cycle's ordering is captured.
    checkStop: () => (dispatchCount > 0 ? (requestStop(root, "one dispatch is enough"), stopDetail(root)) : undefined),
    checkPause: () => {
      order.push("checkPause");
      return pauseDetail(root);
    },
    sleep: async () => {},
  });
  assert.equal(s.stopReason, "stopped");
  const checkPauseIndices = order.reduce<number[]>((acc, v, i) => (v === "checkPause" ? [...acc, i] : acc), []);
  const sweepIdx = order.indexOf("sweep");
  const runOneIdx = order.indexOf("runOne:A");
  assert.ok(
    checkPauseIndices.length >= 2,
    `checkPause was consulted at least twice this tick — top-of-tick AND the re-check before ` +
      `admission — saw ${checkPauseIndices.length} (${JSON.stringify(order)})`,
  );
  const recheckIdx = checkPauseIndices[1];
  assert.ok(sweepIdx !== -1 && sweepIdx < recheckIdx, "the re-check ran AFTER the sweep completed");
  assert.ok(
    runOneIdx !== -1 && recheckIdx < runOneIdx,
    "the re-check ran BEFORE the first admission (dispatch) — the same position the first " +
      "`daemon.iteration` row itself occupies",
  );
});

test("daemon pause: an in-flight batch still drains rather than aborting", async () => {
  const plan = fixturePlan();
  const merged = new Set<string>();
  const root = mkdtempSync(join(tmpdir(), "daemon-pause-drain-"));
  let sleeps = 0;
  const sleep: DaemonDeps["sleep"] = async () => {
    sleeps++;
    if (sleeps >= 2) requestStop(root, "test done polling — pause never cleared");
  };
  const s = await runDaemon(plan, {
    refreshMerged: () => (id) => merged.has(id),
    runOne: async (id) => {
      // The hold appears WHILE A is already admitted and running — the re-check this task adds
      // sits ABOVE admission, never inside `runOne`, so it must never observe or interrupt this
      // call.
      if (id === "A") requestPause(root, "operator hold created while A is in flight");
      merged.add(id);
      return okResult(id);
    },
    checkStop: () => stopDetail(root),
    checkPause: () => pauseDetail(root),
    sleep,
  });
  assert.equal(s.stopReason, "stopped");
  assert.deepEqual(s.merged, ["A"], "A, already in flight when the pause appeared, still reached merged (drain-and-hold)");
  assert.deepEqual(s.attempted, ["A"], "B (A's dependent) was never admitted while the pause held");
});

test("daemon pause: stop gets the same re-check because it has the same single-read shape", async () => {
  const plan = fixturePlan();
  const root = mkdtempSync(join(tmpdir(), "daemon-stop-recheck-sweep-"));
  const lines: Array<{ step: string; extra: Record<string, unknown> }> = [];
  let sweepCalls = 0;
  const s = await runDaemon(plan, {
    refreshMerged: () => () => false,
    runOne: async (id) => {
      throw new Error(
        `runOne must never be called for ${id} — the stop created during the sweep window ` +
          "must be honoured before admission, not after",
      );
    },
    sweep: async () => {
      sweepCalls++;
      requestStop(root, "operator hard-stop created mid-sweep");
    },
    checkStop: () => stopDetail(root),
    checkPause: () => pauseDetail(root),
    sleep: async () => {
      throw new Error("sleep should never be reached — a re-checked STOP returns immediately, it does not idle-poll");
    },
    log: (step, extra = {}) => lines.push({ step, extra }),
  });
  assert.equal(s.stopReason, "stopped");
  assert.equal(sweepCalls, 1, "the sweep ran exactly once — the daemon returned on the very tick the hold appeared");
  assert.deepEqual(s.attempted, [], "no task was ever admitted — the stop created mid-sweep was honoured before admission");
  assert.ok(
    lines.some((l) => l.step === "daemon.stop" && /mid-sweep/.test(String(l.extra.detail))),
    "a daemon.stop row, carrying the SAME detail the existing control already produces, was logged for the re-check",
  );
});

test("daemon pause: the heartbeat records that a pause has been seen while the batch drains", async () => {
  const plan = fixturePlan();
  const merged = new Set<string>();
  const root = mkdtempSync(join(tmpdir(), "daemon-pause-heartbeat-"));
  const lines: Array<{ step: string; extra: Record<string, unknown> }> = [];
  let releaseRunOne: (() => void) | undefined;
  const runOneGate = new Promise<void>((resolve) => {
    releaseRunOne = resolve;
  });
  let sleeps = 0;
  const sleep: DaemonDeps["sleep"] = async () => {
    sleeps++;
    // The operator's hold appears only AFTER the ticker's first heartbeat has already fired —
    // proving one heartbeat recorded "not seen" and a later one, still within the SAME in-flight
    // batch, recorded "seen".
    if (sleeps === 2) requestPause(root, "operator hold created while the batch drains");
    if (sleeps >= 4) releaseRunOne?.();
  };
  const s = await runDaemon(
    plan,
    {
      refreshMerged: () => (id) => merged.has(id),
      runOne: async (id) => {
        await runOneGate;
        merged.add(id);
        return okResult(id);
      },
      sweepLight: async () => {},
      checkStop: () => stopDetail(root),
      checkPause: () => pauseDetail(root),
      sleep,
      log: (step, extra = {}) => lines.push({ step, extra }),
    },
    { max: 1 },
  );
  assert.equal(s.stopReason, "max_reached");
  assert.deepEqual(s.merged, ["A"]);
  const heartbeats = lines.filter((l) => l.step === "daemon.alive" && l.extra.phase === "dispatch");
  assert.ok(heartbeats.length >= 2, `at least 2 dispatch heartbeats fired while A was in flight (saw ${heartbeats.length})`);
  assert.ok(
    heartbeats.some((l) => l.extra.pause_seen === false),
    "an early heartbeat, before the operator's hold existed, recorded pause_seen=false",
  );
  assert.ok(
    heartbeats.some((l) => l.extra.pause_seen === true),
    "a later heartbeat, once the hold existed while A was STILL in flight, recorded pause_seen=true — " +
      "distinguishing seen-and-draining from not-seen-at-all, without aborting A",
  );
});
