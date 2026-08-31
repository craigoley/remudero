import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadPlanFromYaml, type Plan } from "../src/lib/plan.js";
import type { RunResult } from "../src/lib/run-result.js";
import type { MergedSet } from "../src/lib/drain.js";
import { requestStop, stopDetail } from "../src/lib/fleet-control.js";
import {
  API_WINDOW_HOLD_STREAK_FLOOR,
  DEFAULT_MAX_API_WINDOW_HOLD_MS,
  DEFAULT_POLL_INTERVAL_MS,
  INITIAL_API_WINDOW_HOLD_STATE,
  reasonAboutApiWindow,
  runDaemon,
  type ApiWindowHoldState,
} from "../src/lib/daemon.js";

/**
 * W1-T2517 — THE DISPATCH LOOP IS NEVER TOLD THE WINDOW CLOSED.
 *
 * `apiError` is produced 13 times across worker.ts/run-task.ts but reaches daemon.ts ZERO
 * times: run-task.ts's own worker-level retry loop (classify.ts's MAX_TRANSIENT_RETRIES)
 * already gives up and surfaces exactly one honest verdict for that class —
 * `RunResult["verdict"] === "blocked_transient"` (see run-task.ts's own comment: "verdict:
 * blocked_transient — repeated transient API error, not a task failure"). `reasonAboutBlock`
 * (block-reason.ts) already bounds how many times the SAME task id retries that verdict
 * across ticks (W1-T46's `blockRetryStates`, keyed by task id) — but a task-id-keyed budget
 * cannot see a closed usage window, because every NEW task id arrives with a fresh budget and
 * pays a full spawn (worker home, containment preflight, isolation preflight, worktree) to
 * rediscover the SAME closed window. `reasonAboutApiWindow`/`ApiWindowHoldState` (daemon.ts)
 * close that gap: a cross-task, content-keyed counter — mirroring the built, proven
 * `DEFAULT_MAX_SPAWN_INFRA_BACKOFF_MS` shape in the SAME file — that holds dispatch once
 * CONSECUTIVE DIFFERENT task ids end `blocked_transient` in a row.
 */

const okResult = (id: string): RunResult => ({ taskId: id, runId: id + "-run", merged: true, costUsd: 0.1, verdict: "merged" });
const transientResult = (id: string): RunResult => ({ taskId: id, runId: id + "-run", merged: false, costUsd: 0.1, verdict: "blocked_transient" });

/** A fake clock: resolves instantly (no real wall-clock wait) but records every call. */
function fakeSleep(): { sleep: (ms: number) => Promise<void>; calls: number[] } {
  const calls: number[] = [];
  return { sleep: async (ms: number) => { calls.push(ms); }, calls };
}

// ── reasonAboutApiWindow: the pure cross-task counter ───────────────────────

test("W1-T2517: one task ending blocked_transient holds nothing", () => {
  const d = reasonAboutApiWindow(INITIAL_API_WINDOW_HOLD_STATE, "A", "blocked_transient", 1000);
  assert.equal(d.holdMs, 0, "a single refusal is noise, not a fleet-wide signal");
  assert.equal(d.state.streak, 1);
});

test("W1-T2517: the SAME task retrying — however many times — never advances the streak past 1, so it never reads as a fleet-wide outage", () => {
  let state: ApiWindowHoldState = INITIAL_API_WINDOW_HOLD_STATE;
  for (let i = 0; i < 10; i++) {
    const d = reasonAboutApiWindow(state, "A", "blocked_transient", 1000);
    state = d.state;
    assert.equal(d.holdMs, 0, `A's own retry #${i + 1} holds nothing`);
  }
  assert.equal(state.streak, 1, "the streak stays pinned at 1 for one task retrying itself, no matter how many attempts");
});

test("W1-T2517: TWO DIFFERENT task ids ending blocked_transient back-to-back holds dispatch — the discriminator that makes this a fleet-wide signal", () => {
  let state: ApiWindowHoldState = INITIAL_API_WINDOW_HOLD_STATE;
  let d = reasonAboutApiWindow(state, "A", "blocked_transient", 1000);
  state = d.state;
  assert.equal(d.holdMs, 0, "the first task alone still holds nothing");
  d = reasonAboutApiWindow(state, "B", "blocked_transient", 1000);
  state = d.state;
  assert.ok(d.holdMs > 0, "a SECOND, DIFFERENT task id ending the same way holds dispatch");
  assert.equal(state.streak, API_WINDOW_HOLD_STREAK_FLOOR, "exactly two different task ids reaches the floor");
  // Falsifier for a task-id-keyed (rather than cross-task) counter: if B's own budget were
  // tracked separately from A's (mirroring `blockRetryStates`' per-task keying), B's FIRST
  // occurrence would read as B's own "1", never crossing the floor above — the assertion
  // just above would fail. It passing is exactly the cross-task counter this task adds.
});

test("W1-T2517: the hold DOUBLES with each further different-task refusal, capped at maxHoldMs — never grows unbounded", () => {
  let state: ApiWindowHoldState = INITIAL_API_WINDOW_HOLD_STATE;
  const ids = ["A", "B", "C", "D", "E", "F", "G", "H"];
  const holds: number[] = [];
  for (const id of ids) {
    const d = reasonAboutApiWindow(state, id, "blocked_transient", 1000, 3000);
    state = d.state;
    holds.push(d.holdMs);
  }
  assert.deepEqual(holds, [0, 1000, 2000, 3000, 3000, 3000, 3000, 3000], "doubles from the floor, then plateaus at the cap instead of doubling forever");
});

test("W1-T2517: a dispatch reaching a REAL verdict (anything but blocked_transient) resets the streak/hold to the floor", () => {
  let state: ApiWindowHoldState = INITIAL_API_WINDOW_HOLD_STATE;
  let d = reasonAboutApiWindow(state, "A", "blocked_transient", 1000);
  state = d.state;
  d = reasonAboutApiWindow(state, "B", "blocked_transient", 1000);
  state = d.state;
  assert.ok(d.holdMs > 0, "streak reached the floor");
  d = reasonAboutApiWindow(state, "C", "merged", 1000);
  state = d.state;
  assert.equal(d.holdMs, 0, "a real verdict resets immediately");
  assert.deepEqual(state, INITIAL_API_WINDOW_HOLD_STATE, "the state itself is back at its floor, not just the reported holdMs");
  // Post-reset, the NEXT transient refusal starts the count over rather than continuing —
  // proving the reset is a genuine floor, not a one-tick suppression.
  d = reasonAboutApiWindow(state, "D", "blocked_transient", 1000);
  assert.equal(d.holdMs, 0, "one refusal after a reset is, once again, just one refusal");
});

test("W1-T2517: a genuine strike verdict interleaved between two different tasks' refusals breaks the streak — a real failure is never folded into the window signal", () => {
  let state: ApiWindowHoldState = INITIAL_API_WINDOW_HOLD_STATE;
  let d = reasonAboutApiWindow(state, "A", "blocked_transient", 1000);
  state = d.state; // streak 1
  d = reasonAboutApiWindow(state, "B", "failed", 1000);
  state = d.state; // a real strike — resets
  assert.equal(d.holdMs, 0);
  assert.deepEqual(state, INITIAL_API_WINDOW_HOLD_STATE);
  d = reasonAboutApiWindow(state, "C", "blocked_transient", 1000);
  assert.equal(d.holdMs, 0, "the earlier streak was broken by the real failure, so this alone is not enough to hold");
});

test("W1-T2517: DEFAULT_MAX_API_WINDOW_HOLD_MS/API_WINDOW_HOLD_STREAK_FLOOR are exported policy data, not buried literals", () => {
  assert.equal(typeof DEFAULT_MAX_API_WINDOW_HOLD_MS, "number");
  assert.ok(DEFAULT_MAX_API_WINDOW_HOLD_MS > DEFAULT_POLL_INTERVAL_MS);
  assert.equal(typeof API_WINDOW_HOLD_STREAK_FLOOR, "number");
  assert.ok(API_WINDOW_HOLD_STREAK_FLOOR >= 2, "one task alone (streak 1) must stay below the floor");
});

// ── runDaemon: the wiring — a real hold, ledgered and visible ──────────────

/** Two independent tasks, disjoint `files:` so a laneCount>=2 batch co-dispatches both. */
function twoLanePlan(): Plan {
  return loadPlanFromYaml(
    [
      "- id: A",
      "  title: a",
      "  repo: remudero",
      "  type: implement",
      "  depends_on: []",
      "  status: queued",
      "  files: [src/a.ts]",
      "- id: B",
      "  title: b",
      "  repo: remudero",
      "  type: implement",
      "  depends_on: []",
      "  status: queued",
      "  files: [src/b.ts]",
      "",
    ].join("\n"),
    "fixture",
  );
}

const NONE_MERGED: MergedSet = () => false;

test("W1-T2517: TWO DIFFERENT tasks ending blocked_transient in the SAME batch holds dispatch — a ledger row names the reason and the expected resume, and the loop truly sleeps for it", async () => {
  const plan = twoLanePlan();
  const root = mkdtempSync(join(tmpdir(), "daemon-api-window-hold-"));
  const lines: Array<{ step: string; extra: Record<string, unknown> }> = [];
  const { sleep, calls } = fakeSleep();
  const wrappedSleep = async (ms: number) => {
    await sleep(ms);
    requestStop(root, "test done polling");
  };
  const s = await runDaemon(
    plan,
    {
      refreshMerged: () => NONE_MERGED,
      runOne: async (id): Promise<RunResult> => transientResult(id),
      checkStop: () => stopDetail(root),
      sleep: wrappedSleep,
      log: (step, extra = {}) => lines.push({ step, extra }),
    },
    { laneCount: 2, pollIntervalMs: 1000 },
  );
  assert.equal(s.stopReason, "stopped", "the daemon kept running (held, not halted) until the test itself stopped it");
  assert.deepEqual(calls, [1000], "the hold slept exactly once, for pollIntervalMs — streak reached the floor within the first batch");
  const holdLine = lines.find((l) => l.step === "daemon.api_window_hold");
  assert.ok(holdLine, "a daemon.api_window_hold ledger line was emitted");
  assert.equal(holdLine?.extra.hold_ms, 1000);
  assert.equal(holdLine?.extra.consecutive_different_tasks, 2);
  assert.equal(typeof holdLine?.extra.reason, "string");
  assert.ok((holdLine?.extra.reason as string).length > 0, "the reason is a human-legible string, not a bare code");
  assert.equal(typeof holdLine?.extra.resumes_at, "string");
  assert.ok(!Number.isNaN(Date.parse(holdLine?.extra.resumes_at as string)), "resumes_at is a real, parseable instant");
  assert.ok(!lines.some((l) => l.step === "daemon.blocked"), "a held window is never a halt+escalate — the daemon keeps polling");
});

test("W1-T2517: ONE task alone retrying blocked_transient — even many times — never triggers the hold, and the daemon just keeps polling at its ordinary pace", async () => {
  const plan = loadPlanFromYaml(
    ["- id: A", "  title: a", "  repo: remudero", "  type: implement", "  depends_on: []", "  status: queued", ""].join("\n"),
    "fixture",
  );
  const root = mkdtempSync(join(tmpdir(), "daemon-api-window-solo-"));
  const lines: Array<{ step: string; extra: Record<string, unknown> }> = [];
  let calls = 0;
  const sleep = async (_ms: number) => {
    calls++;
    if (calls >= 6) requestStop(root, "test done polling");
  };
  const s = await runDaemon(
    plan,
    {
      refreshMerged: () => NONE_MERGED,
      runOne: async (id): Promise<RunResult> => transientResult(id),
      checkStop: () => stopDetail(root),
      sleep,
      log: (step, extra = {}) => lines.push({ step, extra }),
    },
    { pollIntervalMs: 1000 },
  );
  assert.equal(s.stopReason, "stopped");
  assert.ok(calls >= 6, "the daemon retried the SAME task repeatedly");
  assert.ok(!lines.some((l) => l.step === "daemon.api_window_hold"), "one task looping on its own retries never reads as a fleet-wide outage");
});

test("W1-T2517: a task's own genuine (unfixable) failure still halts + escalates via daemon.blocked — never masked as a window hold, even with a sub-floor streak already in flight", async () => {
  const plan = loadPlanFromYaml(
    [
      "- id: X",
      "  title: x",
      "  repo: remudero",
      "  type: implement",
      "  depends_on: []",
      "  status: queued",
      "  files: [src/x.ts]",
      "- id: Y",
      "  title: y",
      "  repo: remudero",
      "  type: implement",
      "  depends_on: []",
      "  status: queued",
      "  files: [src/y.ts]",
      "- id: Z",
      "  title: z",
      "  repo: remudero",
      "  type: implement",
      "  depends_on: [Y]",
      "  status: queued",
      "  files: [src/z.ts]",
      "",
    ].join("\n"),
    "fixture",
  );
  const merged = new Set<string>();
  const lines: Array<{ step: string; extra: Record<string, unknown> }> = [];
  const { sleep } = fakeSleep();
  const s = await runDaemon(
    plan,
    {
      refreshMerged: () => (id) => merged.has(id),
      runOne: async (id): Promise<RunResult> => {
        if (id === "X") return transientResult("X"); // sub-floor streak: X alone holds nothing
        if (id === "Y") return { taskId: "Y", runId: "Y-run", merged: false, costUsd: 0.2, verdict: "failed" }; // a real, unfixable strike; Z transitively needs Y
        merged.add(id);
        return okResult(id);
      },
      sleep,
      log: (step, extra = {}) => lines.push({ step, extra }),
    },
    { laneCount: 2 },
  );
  assert.equal(s.stopReason, "blocked", "a genuine unfixable blocker still halts the daemon, exactly as before this task existed");
  assert.match(s.stopDetail ?? "", /Y/);
  assert.match(s.stopDetail ?? "", /failed/);
  const blockedLine = lines.find((l) => l.step === "daemon.blocked");
  assert.ok(blockedLine, "a daemon.blocked ledger line was emitted");
  assert.equal(blockedLine?.extra.task, "Y");
  assert.equal(blockedLine?.extra.verdict, "failed");
  assert.deepEqual(blockedLine?.extra.dependents, ["Z"]);
  assert.ok(!lines.some((l) => l.step === "daemon.api_window_hold"), "the streak never reached the floor before the real failure halted the daemon");
});
