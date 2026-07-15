import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadPlan, type Plan } from "../src/lib/plan.js";
import type { RunResult } from "../src/run-task.js";
import type { UsageSnapshot } from "../src/lib/headroom.js";
import { DEFAULT_POLL_INTERVAL_MS, daemonBoot, runDaemon, type DaemonDeps } from "../src/lib/daemon.js";
import { pauseDetail, requestPause, requestStop, stopDetail } from "../src/lib/fleet-control.js";
import type { MergedSet } from "../src/lib/drain.js";

// A small linear-ish plan: A → B → C (chain) + D (independent), all auto.
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
- id: C
  title: c
  repo: remudero
  type: implement
  depends_on: [B]
  status: queued
- id: D
  title: d
  repo: remudero
  type: implement
  depends_on: []
  status: queued
- id: H
  title: human-only
  repo: remudero
  type: implement
  verify: human
  depends_on: []
  status: queued
`;

function fixturePlan(): Plan {
  const dir = mkdtempSync(join(tmpdir(), "daemon-"));
  const f = join(dir, "tasks.yaml");
  writeFileSync(f, YAML);
  return loadPlan(f);
}

const NONE_MERGED: MergedSet = () => false;
function mergedSetOf(...ids: string[]): MergedSet {
  const s = new Set(ids);
  return (id) => s.has(id);
}

const okResult = (id: string): RunResult => ({ taskId: id, runId: id + "-run", merged: true, costUsd: 0.5, verdict: "merged" });
const blockedResult = (id: string): RunResult => ({
  taskId: id,
  runId: id + "-run",
  merged: false,
  costUsd: 0.3,
  verdict: "blocked_review",
  prUrl: "https://github.com/o/r/pull/9",
});

/** A fake clock: resolves instantly (no real wall-clock wait) but records every call. */
function fakeClock(): { sleep: (ms: number) => Promise<void>; calls: number[] } {
  const calls: number[] = [];
  return { sleep: async (ms: number) => { calls.push(ms); }, calls };
}

// ── daemonBoot: the ANTHROPIC-clean-env boot assertion (W1-T12b) ───────────
// Run entirely in-process over an injected log + env — NO real launchd load
// (that live commissioning step is W1-T12d).

test("daemonBoot: a clean env logs daemon.boot with env_clean=true, billing_mode=subscription", () => {
  const lines: Array<{ step: string; extra: Record<string, unknown> }> = [];
  const cleanEnv = { PATH: "/usr/bin:/bin", HOME: "/Users/op" };
  const result = daemonBoot((step, extra = {}) => lines.push({ step, extra }), cleanEnv);
  assert.deepEqual(result, { env_clean: true, billing_mode: "subscription" });
  assert.equal(lines.length, 1);
  assert.equal(lines[0].step, "daemon.boot");
  assert.equal(lines[0].extra.env_clean, true);
  assert.equal(lines[0].extra.billing_mode, "subscription");
});

test("daemonBoot: a contaminated env (ANTHROPIC_* present) still logs, but env_clean=false — a loud canary, not a throw", () => {
  const lines: Array<{ step: string; extra: Record<string, unknown> }> = [];
  const dirtyEnv = { PATH: "/usr/bin:/bin", HOME: "/Users/op", ANTHROPIC_API_KEY: "KEY-SHOULD-NEVER-SURVIVE" };
  const result = daemonBoot((step, extra = {}) => lines.push({ step, extra }), dirtyEnv);
  assert.deepEqual(result, { env_clean: false, billing_mode: "subscription" });
  assert.equal(lines[0].extra.env_clean, false);
  assert.equal(lines[0].extra.billing_mode, "subscription", "billing_mode is always subscription — this repo never runs a daemon in api mode");
});

test("daemonBoot: defaults to checking process.env when no env is injected", () => {
  const lines: Array<{ step: string; extra: Record<string, unknown> }> = [];
  const prior = process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  try {
    const result = daemonBoot((step, extra = {}) => lines.push({ step, extra }));
    assert.equal(result.env_clean, true);
  } finally {
    if (prior !== undefined) process.env.ANTHROPIC_API_KEY = prior;
  }
});

// ── dispatch order: reuses drain.ts's DAG selection, never reimplements it ──

test("dispatches in dependency order (DAG), skipping verify:human and merged tasks", async () => {
  const plan = fixturePlan();
  const merged = new Set<string>();
  const ran: string[] = [];
  const clock = fakeClock();
  const s = await runDaemon(
    plan,
    {
      refreshMerged: () => (id) => merged.has(id),
      runOne: async (id) => { ran.push(id); merged.add(id); return okResult(id); },
      sleep: clock.sleep,
    },
    { max: 4 },
  );
  assert.deepEqual(ran, ["A", "B", "C", "D"]); // A before B before C (deps); D independent
  assert.deepEqual(s.merged, ["A", "B", "C", "D"]);
  assert.equal(s.stopReason, "max_reached");
  assert.ok(!ran.includes("H"), "verify:human is never auto-dispatched");
});

// ── STOP / PAUSE (W1-T11) ───────────────────────────────────────────────────

test("STOP: checked first, every tick — halts within one tick, no subsequent spawns", async () => {
  const plan = fixturePlan();
  const merged = new Set<string>();
  const root = mkdtempSync(join(tmpdir(), "daemon-stop-"));
  const ran: string[] = [];
  const lines: Array<{ step: string; extra: Record<string, unknown> }> = [];
  const clock = fakeClock();
  const s = await runDaemon(plan, {
    refreshMerged: () => (id) => merged.has(id),
    runOne: async (id) => {
      ran.push(id);
      requestStop(root, "operator hard-stop");
      merged.add(id);
      return okResult(id);
    },
    checkStop: () => stopDetail(root),
    checkPause: () => pauseDetail(root),
    sleep: clock.sleep,
    log: (step, extra = {}) => lines.push({ step, extra }),
  });
  assert.equal(s.stopReason, "stopped");
  assert.deepEqual(ran, ["A"]); // STOP is checked at the very next tick — no B/C/D
  assert.ok(
    lines.some((l) => l.step === "daemon.stop" && /operator hard-stop/.test(String(l.extra.detail))),
    "a daemon.stop ledger line, carrying the reason, was emitted",
  );
});

test("STOP set before the daemon even starts: zero tasks attempted", async () => {
  const plan = fixturePlan();
  const root = mkdtempSync(join(tmpdir(), "daemon-stop-pre-"));
  requestStop(root, "pre-armed");
  let spawned = 0;
  const clock = fakeClock();
  const s = await runDaemon(plan, {
    refreshMerged: () => NONE_MERGED,
    runOne: async (id) => { spawned++; return okResult(id); },
    checkStop: () => stopDetail(root),
    checkPause: () => pauseDetail(root),
    sleep: clock.sleep,
  });
  assert.equal(s.stopReason, "stopped");
  assert.equal(spawned, 0);
  assert.deepEqual(s.attempted, []);
});

test("STOP takes precedence over PAUSE when both flags are set", async () => {
  const plan = fixturePlan();
  const root = mkdtempSync(join(tmpdir(), "daemon-both-"));
  requestPause(root, "b");
  requestStop(root, "a");
  const clock = fakeClock();
  const s = await runDaemon(plan, {
    refreshMerged: () => NONE_MERGED,
    runOne: async (id) => okResult(id),
    checkStop: () => stopDetail(root),
    checkPause: () => pauseDetail(root),
    sleep: clock.sleep,
  });
  assert.equal(s.stopReason, "stopped");
});

test("PAUSE (drain-and-hold): issued mid-run, the in-flight task still reaches merged; no new spawn follows", async () => {
  const plan = fixturePlan();
  const merged = new Set<string>();
  const root = mkdtempSync(join(tmpdir(), "daemon-pause-"));
  const lines: Array<{ step: string; extra: Record<string, unknown> }> = [];
  const clock = fakeClock();
  const s = await runDaemon(plan, {
    refreshMerged: () => (id) => merged.has(id),
    runOne: async (id) => {
      // Simulate an operator pausing WHILE task A is in flight — the flag
      // appears mid-run, before A resolves.
      if (id === "A") requestPause(root, "quiet hours");
      merged.add(id);
      return okResult(id);
    },
    checkStop: () => stopDetail(root),
    checkPause: () => pauseDetail(root),
    sleep: clock.sleep,
    log: (step, extra = {}) => lines.push({ step, extra }),
  });
  assert.equal(s.stopReason, "paused");
  assert.deepEqual(s.merged, ["A"]); // A still reaches merged (drain-and-hold)
  assert.deepEqual(s.attempted, ["A"]); // B (A's dependent) never spawns
  assert.ok(lines.some((l) => l.step === "daemon.pause"), "a daemon.pause ledger line was emitted");
});

// ── headroom (W1-T4) ─────────────────────────────────────────────────────────

test("headroom: a near-limit reading STOPS with reason=headroom_exhausted BEFORE spawning", async () => {
  const plan = fixturePlan();
  const nearLimit: UsageSnapshot = {
    billingMode: "subscription",
    session: { percentUsed: 42, resetsAt: "3pm" },
    weekly: [{ label: "all models", percentUsed: 98, resetsAt: "Monday" }],
  };
  let spawned = 0;
  const clock = fakeClock();
  const s = await runDaemon(plan, {
    refreshMerged: () => NONE_MERGED,
    runOne: async (id) => { spawned++; return okResult(id); },
    readUsage: () => nearLimit,
    sleep: clock.sleep,
  });
  assert.equal(s.stopReason, "headroom_exhausted");
  assert.match(s.stopDetail ?? "", /weekly \(all models\) at 98% — resets Monday/);
  assert.equal(spawned, 0, "no task is spawned when a window is at/near its limit");
});

test("headroom unreadable (undefined) does NOT halt — best-effort, the daemon continues", async () => {
  const plan = fixturePlan();
  const merged = new Set<string>();
  const clock = fakeClock();
  const s = await runDaemon(
    plan,
    {
      refreshMerged: () => (id) => merged.has(id),
      runOne: async (id) => { merged.add(id); return okResult(id); },
      readUsage: () => undefined,
      sleep: clock.sleep,
    },
    { max: 1 },
  );
  assert.equal(s.stopReason, "max_reached");
  assert.deepEqual(s.merged, ["A"]);
});

// ── stop-on-block v1 (block-REASONING is W1-T46, a successor built on this) ─

test("stop-on-block: a blocked task HALTS the daemon and does NOT run its dependents", async () => {
  const plan = fixturePlan();
  const merged = new Set<string>();
  const ran: string[] = [];
  const clock = fakeClock();
  const s = await runDaemon(plan, {
    refreshMerged: () => (id) => merged.has(id),
    runOne: async (id) => {
      ran.push(id);
      if (id === "B") return blockedResult(id); // A merges; B blocks; C must never run.
      merged.add(id);
      return okResult(id);
    },
    sleep: clock.sleep,
  });
  assert.equal(s.stopReason, "blocked");
  assert.match(s.stopDetail ?? "", /B → blocked_review/);
  assert.deepEqual(s.merged, ["A"]);
  assert.deepEqual(ran, ["A", "B"]);
  assert.ok(!ran.includes("C"), "the blocked task's dependent must not run");
});

// ── the PERSISTENT difference from `rmd drain`: it polls instead of stopping ─

test("no runnable task right now: the daemon PACES itself (injected clock) and keeps polling instead of stopping", async () => {
  const plan = fixturePlan();
  // Everything except H (verify:human) is already merged — nothing runnable.
  const isMerged = mergedSetOf("A", "B", "C", "D");
  let calls = 0;
  const sleep: DaemonDeps["sleep"] = async (ms) => {
    calls++;
    // After a few idle ticks, this "test operator" issues STOP so the test
    // terminates — proving the loop was genuinely idling/polling, not stuck.
    if (calls >= 3) requestStop(root, "test done polling");
  };
  const root = mkdtempSync(join(tmpdir(), "daemon-idle-"));
  const s = await runDaemon(plan, {
    refreshMerged: () => isMerged,
    runOne: async (id) => okResult(id),
    checkStop: () => stopDetail(root),
    sleep,
  });
  assert.equal(s.stopReason, "stopped");
  assert.equal(s.attempted.length, 0, "nothing was ever dispatched — only H remained, and it is verify:human");
  assert.ok(s.ticks >= 3, "the loop idle-polled via the injected clock rather than exiting on no_runnable");
  assert.equal(calls, s.ticks, "one sleep() call per idle tick");
});

test("default poll interval is passed to the injected clock unless overridden", async () => {
  const plan = fixturePlan();
  const isMerged = mergedSetOf("A", "B", "C", "D");
  const seen: number[] = [];
  const root = mkdtempSync(join(tmpdir(), "daemon-poll-ms-"));
  await runDaemon(plan, {
    refreshMerged: () => isMerged,
    runOne: async (id) => okResult(id),
    checkStop: () => {
      if (seen.length >= 1) return stopDetail(root) ?? "stop";
      requestStop(root, "one tick is enough");
      return undefined;
    },
    sleep: async (ms) => { seen.push(ms); },
  });
  assert.deepEqual(seen, [DEFAULT_POLL_INTERVAL_MS]);
});

// ── max (a bounded supervised run, or a test) ───────────────────────────────

test("--max N halts after N successful tasks (absent = unbounded, unlike a test run)", async () => {
  const plan = fixturePlan();
  const merged = new Set<string>();
  const clock = fakeClock();
  const s = await runDaemon(
    plan,
    {
      refreshMerged: () => (id) => merged.has(id),
      runOne: async (id) => { merged.add(id); return okResult(id); },
      sleep: clock.sleep,
    },
    { max: 2 },
  );
  assert.equal(s.stopReason, "max_reached");
  assert.deepEqual(s.merged, ["A", "B"]);
  assert.equal(s.attempted.length, 2);
});

// ── an unexpected throw from the runner is a terminal (not a silent loop) ──

test("an unexpected error from runOne is a terminal 'error' stop, naming the task", async () => {
  const plan = fixturePlan();
  const clock = fakeClock();
  const s = await runDaemon(plan, {
    refreshMerged: () => NONE_MERGED,
    runOne: async () => { throw new Error("boom"); },
    sleep: clock.sleep,
  });
  assert.equal(s.stopReason, "error");
  assert.match(s.stopDetail ?? "", /A: boom/);
});
