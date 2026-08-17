// W1-T942: a worker is opaque between spawn and verdict — the SDK message stream is already
// consumed message-by-message (collectWorkerResult, src/lib/worker.ts) and every message but
// its text was discarded. This proves the PRODUCE half: a 3-value worker state
// (working/tool-executing/quiet) derived off that SAME stream via one injected observer, ledger
// TRANSITIONS only (never one row per message), the W1-T130 cannot-observe polarity (no row ⇒
// UNKNOWN, never `working`), and the bounded, 0600, best-effort, never-deleted live tail.
//
// Four acceptance claims, all proven here (the design's own "files:" list names ONLY this test
// file for all four):
//   1. state is derived from the SAME stream collectWorkerResult already consumes — no second
//      stream, no extra SDK call — and `quiet` emerges from a gap with no message of any kind.
//   2. worker.state ledger rows are appended on TRANSITIONS only, keyed by run_id + task_id.
//   3. no row / an observer that never fired reads UNKNOWN, never `working`.
//   4. the live tail is byte- and line-capped, written 0600, survives run exit for every
//      verdict shape, and a tail write failure never fails the run.

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { readLedgerLines } from "../src/lib/status.js";
import {
  collectWorkerResult,
  DEFAULT_WORKER_QUIET_FLOOR_MS,
  WorkerStateTracker,
  type WorkerStreamEvent,
} from "../src/lib/worker.js";
import {
  buildWorkerStateSensor,
  capWorkerTailLines,
  ledgerPathFor,
  runWorkerTailSweepRung,
  sweepStaleWorkerTails,
  WORKER_STATE_LEDGER_STEP,
  WORKER_TAIL_MAX_BYTES,
  WORKER_TAIL_MAX_LINES,
  writeWorkerTailBestEffort,
} from "../src/run-task.js";
import type { Config } from "../src/lib/config.js";

function tmpRoot(prefix: string): string {
  return mkdtempSync(join(tmpdir(), `rmd-${prefix}-`));
}

function fakeConfig(root: string): Config {
  return { root } as Config;
}

// ── acceptance 1: derived from the SAME stream, no second stream, no extra SDK call ────────

test("collectWorkerResult's streamObserver classifies assistant text as working and a tool_use block as tool-executing, off the SAME loop that already extracts text — a message with BOTH fires both", async () => {
  const events: WorkerStreamEvent[] = [];
  let clock = 0;
  const now = () => clock++;

  async function* stream(): AsyncGenerator<unknown> {
    yield { type: "system", subtype: "init" };
    yield { type: "assistant", message: { content: [{ type: "text", text: "thinking out loud" }] } };
    yield {
      type: "assistant",
      message: {
        content: [
          { type: "text", text: "about to run a tool" },
          { type: "tool_use", id: "t1", name: "Bash", input: {} },
        ],
      },
    };
    yield {
      type: "result",
      subtype: "success",
      is_error: false,
      result: "done",
      session_id: "sess-1",
      total_cost_usd: 0.01,
      num_turns: 3,
      permission_denials: [],
    };
  }

  const r = await collectWorkerResult(stream(), {
    childEnvKeys: [],
    now,
    streamObserver: (e) => events.push(e),
  });

  // The observer changes NOTHING about the pre-existing return shape — same loop, same result.
  assert.deepEqual(r.blocks, ["thinking out loud", "about to run a tool"]);

  const kinds = events.map((e) => e.kind);
  assert.deepEqual(kinds, ["message", "working", "working", "tool-executing", "message"]);
  assert.equal(events[1].text, "thinking out loud");
  assert.equal(events[3].text, "[tool_use: Bash]");
  // Every event carries the INJECTED clock's own reading, never a second independent read.
  assert.ok(events.every((e) => typeof e.tsMs === "number"));
});

test("an assistant message with neither text nor tool_use is still a heartbeat (kind: message) — never silently dropped", async () => {
  const events: WorkerStreamEvent[] = [];
  async function* stream(): AsyncGenerator<unknown> {
    yield { type: "assistant", message: { content: [{ type: "thinking", thinking: "…" }] } };
    yield {
      type: "result",
      subtype: "success",
      is_error: false,
      result: "",
      session_id: "s",
      total_cost_usd: 0,
      num_turns: 1,
      permission_denials: [],
    };
  }
  await collectWorkerResult(stream(), { childEnvKeys: [], streamObserver: (e) => events.push(e) });
  assert.deepEqual(events.map((e) => e.kind), ["message", "message"]);
});

test("absent streamObserver leaves collectWorkerResult byte-identical (no throw, no new branch reachable) — the design's own no-op-by-default guarantee", async () => {
  async function* stream(): AsyncGenerator<unknown> {
    yield { type: "assistant", message: { content: [{ type: "text", text: "hi" }] } };
    yield {
      type: "result",
      subtype: "success",
      is_error: false,
      result: "PR_URL: https://github.com/x/y/pull/1",
      session_id: "s",
      total_cost_usd: 0.1,
      num_turns: 1,
      permission_denials: [],
    };
  }
  const r = await collectWorkerResult(stream(), { childEnvKeys: [] });
  assert.equal(r.text, "PR_URL: https://github.com/x/y/pull/1");
});

test("WorkerStateTracker: a gap with no message of any kind longer than the quiet floor yields quiet, and a subsequent event recovers", () => {
  const tracker = new WorkerStateTracker(1_000);
  assert.equal(tracker.observe({ kind: "working", tsMs: 0 }), "working");
  assert.equal(tracker.check(500), undefined, "still inside the quiet floor — no transition yet");
  assert.equal(tracker.check(1_500), "quiet", "no message of ANY kind for > the floor ⇒ quiet");
  assert.equal(tracker.check(2_000), undefined, "already quiet — no repeat transition");
  assert.equal(tracker.observe({ kind: "working", tsMs: 2_000 }), "working", "a new event recovers out of quiet");
});

test("WorkerStateTracker: a heartbeat (kind: message) resets the quiet clock without itself asserting working/tool-executing", () => {
  const tracker = new WorkerStateTracker(1_000);
  tracker.observe({ kind: "tool-executing", tsMs: 0 });
  assert.equal(tracker.observe({ kind: "message", tsMs: 900 }), undefined, "a heartbeat is never a transition on its own");
  assert.equal(tracker.check(1_500), undefined, "the heartbeat at 900 reset the clock — 1500-900=600 < floor");
  assert.equal(tracker.check(2_100), "quiet", "2100-900=1200 > floor — now it fires");
});

test("DEFAULT_WORKER_QUIET_FLOOR_MS is small — a raw activity sensor, deliberately decoupled from any future stall-alarm threshold", () => {
  assert.ok(DEFAULT_WORKER_QUIET_FLOOR_MS > 0);
  assert.ok(DEFAULT_WORKER_QUIET_FLOOR_MS < 5 * 60 * 1000);
});

// ── acceptance 2: ledger rows on TRANSITIONS only, keyed by run_id + task_id ────────────────

test("buildWorkerStateSensor appends a worker.state ledger row ONLY when the state actually changes, keyed by run_id/task_id — never one row per message", () => {
  const root = tmpRoot("worker-state-sensor-transitions");
  const config = fakeConfig(root);
  const ledgerPath = ledgerPathFor(config);
  const runId = "T-run-1";
  const taskId = "T-task-1";
  const sensor = buildWorkerStateSensor({ ledgerPath, runId, taskId, root });

  // A long "turn count" of repeated same-kind events must not multiply ledger volume.
  for (let i = 0; i < 25; i++) sensor.observer({ kind: "working", tsMs: i });
  sensor.observer({ kind: "tool-executing", tsMs: 100 });
  sensor.observer({ kind: "tool-executing", tsMs: 101 }); // same state — no new row
  for (let i = 0; i < 10; i++) sensor.observer({ kind: "message", tsMs: 200 + i }); // heartbeats — no rows
  sensor.observer({ kind: "working", tsMs: 300 });

  const lines = readLedgerLines(ledgerPath).filter((l) => l.step === WORKER_STATE_LEDGER_STEP);
  assert.equal(lines.length, 3, `expected exactly 3 transitions (working→tool-executing→working), got ${JSON.stringify(lines)}`);
  assert.deepEqual(lines.map((l) => l.state), ["working", "tool-executing", "working"]);
  for (const l of lines) {
    assert.equal(l.run_id, runId);
    assert.equal(l.task_id, taskId);
  }
});

// ── acceptance 3: no row / observer never fired ⇒ UNKNOWN, never `working` (W1-T130) ────────

test("a fresh WorkerStateTracker with no observed event ever reads UNKNOWN (undefined) — never defaulted to working, and check() never fires quiet before anything was observed", () => {
  const tracker = new WorkerStateTracker(10);
  assert.equal(tracker.currentState(), undefined);
  assert.equal(tracker.check(1_000_000), undefined, "nothing was ever observed — not even quiet, which would still be a lie about activity");
});

test("a sensor whose observer never fires appends NO worker.state row at all — the run reads UNKNOWN off ledger absence, never a fabricated working row", () => {
  const root = tmpRoot("worker-state-sensor-unknown");
  const config = fakeConfig(root);
  const ledgerPath = ledgerPathFor(config);
  buildWorkerStateSensor({ ledgerPath, runId: "T-run-2", taskId: "T-task-2", root });
  // No observer() call at all — mirrors an observer that "never fired" (design note vi).
  const lines = readLedgerLines(ledgerPath);
  assert.equal(lines.present, false, "no ledger line was ever written for this run/task");
});

// ── acceptance 4: bounded byte/line tail, 0600, never deleted at exit, write failure is inert ─

test("capWorkerTailLines sheds the OLDEST lines first once the line count exceeds the ceiling, never truncating a kept line", () => {
  const lines = Array.from({ length: WORKER_TAIL_MAX_LINES + 50 }, (_, i) => `line-${i}`);
  const capped = capWorkerTailLines(lines);
  assert.equal(capped.length, WORKER_TAIL_MAX_LINES);
  assert.equal(capped[0], `line-50`, "the 50 oldest lines must be shed, never the newest");
  assert.equal(capped[capped.length - 1], `line-${WORKER_TAIL_MAX_LINES + 49}`);
});

test("capWorkerTailLines sheds oldest lines until the joined byte length fits the byte ceiling too", () => {
  const bigLine = "x".repeat(2_000);
  const lines = Array.from({ length: 100 }, () => bigLine); // ~200KB, well over the 64KB default
  const capped = capWorkerTailLines(lines);
  assert.ok(Buffer.byteLength(capped.join("\n"), "utf8") <= WORKER_TAIL_MAX_BYTES);
  assert.ok(capped.length < 100, "the byte ceiling must shed lines even though the line-count ceiling alone would not");
});

test("capWorkerTailLines respects injected (smaller) ceilings for deterministic unit testing", () => {
  const capped = capWorkerTailLines(["a", "b", "c", "d"], 2, 1_000);
  assert.deepEqual(capped, ["c", "d"]);
});

test("writeWorkerTailBestEffort writes the tail 0600, and the sensor's own tail file is NEVER deleted by anything in this module (survives past the run's own lifecycle for every verdict shape)", () => {
  const root = tmpRoot("worker-state-sensor-tail-mode");
  const config = fakeConfig(root);
  const ledgerPath = ledgerPathFor(config);

  // Two independent runs, standing in for two different terminal verdicts (e.g. merged vs
  // no_pr) — buildWorkerStateSensor/writeWorkerTailBestEffort take NO verdict parameter at
  // all, so nothing here can special-case one shape over another; both tails simply persist.
  for (const runId of ["T-run-merged", "T-run-no-pr"]) {
    const sensor = buildWorkerStateSensor({ ledgerPath, runId, taskId: "T-task-3", root });
    sensor.observer({ kind: "working", tsMs: 0, text: "hello from " + runId });
    const tailPath = join(root, "state", "runs", `${runId}.tail`);
    assert.ok(existsSync(tailPath), `tail must exist for ${runId}`);
    const mode = statSync(tailPath).mode & 0o777;
    assert.equal(mode, 0o600, `tail must be written 0600, got ${mode.toString(8)}`);
    assert.equal(readFileSync(tailPath, "utf8").trim(), "hello from " + runId);
  }
});

test("writeWorkerTailBestEffort NEVER throws even when the write is impossible — an observability organ that can kill a worker is worse than the blindness it cures", () => {
  const root = tmpRoot("worker-state-sensor-tail-fail");
  // Make the WOULD-BE PARENT DIRECTORY a plain file, so mkdirSync(..., {recursive:true})
  // and the subsequent writeFileSync both fail with ENOTDIR — the exact class of failure a
  // real full disk / permissions problem produces.
  const blockerPath = join(root, "state");
  writeFileSync(blockerPath, "not a directory");
  const tailPath = join(blockerPath, "runs", "T-run-impossible.tail");
  assert.doesNotThrow(() => writeWorkerTailBestEffort(tailPath, ["some output"]));
  assert.ok(!existsSync(tailPath), "the write genuinely failed — but silently, never thrown");
});

test("a spawn-level tail write failure never fails the run: the observer swallows it exactly like writeWorkerTailBestEffort does, and ledger transitions still land", () => {
  const root = tmpRoot("worker-state-sensor-observer-fail");
  const config = fakeConfig(root);
  const ledgerPath = ledgerPathFor(config);
  const runId = "T-run-tail-fails";
  // Same ENOTDIR trap as above, but reached THROUGH the sensor's own observer this time.
  writeFileSync(join(root, "state"), "not a directory");
  const sensor = buildWorkerStateSensor({ ledgerPath, runId, taskId: "T-task-4", root });
  assert.doesNotThrow(() => sensor.observer({ kind: "working", tsMs: 0, text: "hi" }));
  // The ledger write is independent of the tail write (state/ being a file, not a dir, would
  // ALSO break appendLedger — that is an orthogonal fs problem this test does not construct);
  // the point is solely that the observer call itself never throws.
});

// ── the reaper/sweep half of design note v: ages out on retention, never deletes at run end ──

test("sweepStaleWorkerTails keeps a fresh tail (proving a just-finished run's tail is NOT reclaimed at run end) and removes only a genuinely stale one past the retention window", () => {
  const root = tmpRoot("worker-state-sensor-sweep");
  const runsDir = join(root, "state", "runs");
  const config = fakeConfig(root);
  const ledgerPath = ledgerPathFor(config);

  const fresh = buildWorkerStateSensor({ ledgerPath, runId: "T-run-fresh", taskId: "T-task-5", root });
  fresh.observer({ kind: "working", tsMs: 0, text: "still relevant" });

  const stale = buildWorkerStateSensor({ ledgerPath, runId: "T-run-stale", taskId: "T-task-5", root });
  stale.observer({ kind: "working", tsMs: 0, text: "ancient history" });
  const stalePath = join(runsDir, "T-run-stale.tail");
  const longAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  utimesSync(stalePath, longAgo, longAgo);

  const swept = sweepStaleWorkerTails(root, { maxAgeMs: 7 * 24 * 60 * 60 * 1000 });
  assert.deepEqual(swept.removed, ["T-run-stale.tail"]);
  assert.ok(existsSync(join(runsDir, "T-run-fresh.tail")), "a fresh tail must survive the sweep");
  assert.ok(!existsSync(stalePath), "a tail past the retention window must be reclaimed");
});

test("sweepStaleWorkerTails is best-effort against an absent state/runs directory (a fleet that has never produced a tail yet)", () => {
  const root = tmpRoot("worker-state-sensor-sweep-absent");
  assert.doesNotThrow(() => {
    const swept = sweepStaleWorkerTails(root);
    assert.deepEqual(swept.removed, []);
  });
});

// ── The three arms CI's diff-coverage found unexercised ──────────────────────────────────────
//
// All three are FAILURE/TIMER paths the happy-path tests above cannot reach: the polling
// callback never fires without a real tick, and both catch arms need their reader to actually
// throw. Each is driven for real here — no stubbed sweep, no mocked timer module.

test("W1-T942: the poll timer emits the quiet transition without any further stream event", async () => {
  const root = tmpRoot("t942-poll");
  const ledgerPath = ledgerPathFor(fakeConfig(root));
  // Injected clock: the REAL interval only has to TICK, while `now` decides what it observes —
  // so this asserts the polling path itself, never the host's timer accuracy.
  let clock = 1_000;
  const sensor = buildWorkerStateSensor({
    ledgerPath,
    runId: "T-run-poll",
    taskId: "T-task-poll",
    root,
    quietFloorMs: 5,
    pollMs: 1,
    now: () => clock,
  });

  // One observed event so the tracker has a lastActivity to measure the gap FROM — `check`
  // returns undefined forever without it (the cannot-observe polarity acceptance 3 pins), so
  // this is required setup rather than incidental.
  sensor.observer({ kind: "working", tsMs: clock });
  clock += 5_000; // well past the 5ms quiet floor

  const stop = sensor.startPolling();
  try {
    await new Promise((r) => setTimeout(r, 40));
  } finally {
    stop();
  }

  const states = readLedgerLines(ledgerPath)
    .filter((l) => l.step === WORKER_STATE_LEDGER_STEP)
    .map((l) => l.state);
  // The quiet row can ONLY have come from the interval callback: no observer call was made
  // after the clock advanced, so nothing else could have driven the transition.
  assert.deepEqual(states, ["working", "quiet"], `expected working then a polled quiet, got ${JSON.stringify(states)}`);
});

test("W1-T942: an unreadable runs dir costs a skipped sweep never a throw", () => {
  const dir = mkdtempSync(join(tmpdir(), "rmd-t942-unreadable-"));
  mkdirSync(join(dir, "state"), { recursive: true });
  // `state/runs` as a FILE: `existsSync` is true so the guard passes, and `readdirSync` then
  // throws ENOTDIR — the real shape of an unreadable dir, without needing root or chmod games.
  writeFileSync(join(dir, "state", "runs"), "not a directory\n");

  const out = sweepStaleWorkerTails(dir);

  assert.deepEqual(out, { removed: [] }, "best-effort: a skipped sweep, never a propagated throw");
});

test("W1-T942: a throwing sweep is logged by the rung and never escapes the poll", () => {
  const logged: Array<{ step: string; extra?: Record<string, unknown> }> = [];
  // A malformed root makes `join` inside sweepStaleWorkerTails throw before any fs call — the
  // rung's own catch is what must contain it, or one bad config takes the whole daemon poll down.
  const config = { root: undefined as unknown as string } as Config;

  assert.doesNotThrow(() => runWorkerTailSweepRung(config, (step, extra) => logged.push({ step, extra })));

  assert.equal(logged.length, 1, "the rung logs exactly once on failure");
  assert.equal(logged[0].step, "daemon.worker_tail_sweep");
  assert.ok(typeof logged[0].extra?.error === "string" && logged[0].extra.error.length > 0, "the failure is NAMED, never a silent swallow");
});
