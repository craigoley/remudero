import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadPlan, type Plan } from "../src/lib/plan.js";
import type { RunResult } from "../src/run-task.js";
import type { UsageSnapshot } from "../src/lib/headroom.js";
import { UNREADABLE_DEGRADED_LIMIT } from "../src/lib/headroom.js";
import { runDrain } from "../src/lib/drain.js";

/**
 * W1-T290: the daemon's bounded-degraded ceiling on CONSECUTIVE unreadable `/usage`
 * reads, ported to the drain (both `runDrain`'s single-lane loop and `runDrainLanes`'
 * multi-lane pass — see src/lib/drain.ts). Before this task, an unreadable read never
 * overturned dispatch at either site (`over = snap ? headroomExhausted(...) : null`
 * treats "unreadable" and "healthy" identically) — so a drain that coincided with a
 * genuinely exhausted window kept spawning against it, bounded only by `--max` and the
 * per-task budget tripwire. test/drain.test.ts's own "does NOT halt" test enshrined
 * exactly that fail-open shape; it is retargeted (not deleted) alongside this file.
 *
 * Fixture: six independent auto tasks (no depends_on), so `nextRunnable`'s file-order
 * scan always has a next candidate ready — nothing here should ever stop for
 * `no_runnable`, isolating the headroom ceiling as the only thing under test. Each
 * carries its own disjoint `files:` (mirroring test/parallel-dispatch.test.ts's
 * fixture) so the multi-lane pass's W1-T171 file-overlap partition never serializes
 * them down to one-per-pass — the lane budget alone governs how many co-dispatch.
 */
const YAML = `
- id: A
  title: a
  repo: remudero
  type: implement
  depends_on: []
  status: queued
  files: [src/a.ts]
- id: B
  title: b
  repo: remudero
  type: implement
  depends_on: []
  status: queued
  files: [src/b.ts]
- id: C
  title: c
  repo: remudero
  type: implement
  depends_on: []
  status: queued
  files: [src/c.ts]
- id: D
  title: d
  repo: remudero
  type: implement
  depends_on: []
  status: queued
  files: [src/d.ts]
- id: E
  title: e
  repo: remudero
  type: implement
  depends_on: []
  status: queued
  files: [src/e.ts]
- id: F
  title: f
  repo: remudero
  type: implement
  depends_on: []
  status: queued
  files: [src/f.ts]
`;

function fixturePlan(): Plan {
  const dir = mkdtempSync(join(tmpdir(), "drain-unreadable-degraded-"));
  const f = join(dir, "tasks.yaml");
  writeFileSync(f, YAML);
  return loadPlan(f);
}

const okResult = (id: string): RunResult => ({ taskId: id, runId: id + "-run", merged: true, costUsd: 0.1, verdict: "merged" });

/** Comfortably under any limit — a "good" read, never `headroom_exhausted`. */
const HEALTHY_SNAPSHOT: UsageSnapshot = {
  billingMode: "subscription",
  session: { percentUsed: 10 },
  weekly: [{ label: "all models", percentUsed: 20 }],
};

function recordingLog(): { log: (step: string, extra?: Record<string, unknown>) => void; lines: string[] } {
  const lines: string[] = [];
  return { log: (step) => lines.push(step), lines };
}

// ── acceptance 1: WITHIN the allowance, both loops still dispatch ───────────

test("single-lane: WITHIN the bounded allowance an unreadable /usage still dispatches, tick after tick", async () => {
  const plan = fixturePlan();
  const merged = new Set<string>();
  const s = await runDrain(
    plan,
    {
      refreshMerged: () => (id) => merged.has(id),
      runOne: async (id) => { merged.add(id); return okResult(id); },
      readUsage: () => undefined,
    },
    { max: 2, unreadableDegradedLimit: 2 },
  );
  assert.equal(s.stopReason, "max_reached", "2 consecutive misses, limit 2 — never exceeded, so --max wins first");
  assert.deepEqual(s.merged, ["A", "B"]);
});

test("the default unreadableDegradedLimit is the SHARED UNREADABLE_DEGRADED_LIMIT constant (headroom.ts), not a second literal", async () => {
  const plan = fixturePlan();
  const merged = new Set<string>();
  const s = await runDrain(
    plan,
    {
      refreshMerged: () => (id) => merged.has(id),
      runOne: async (id) => { merged.add(id); return okResult(id); },
      readUsage: () => undefined,
    },
    { max: UNREADABLE_DEGRADED_LIMIT + 5 }, // no override — exercises the DEFAULT.
  );
  assert.equal(s.stopReason, "headroom_degraded");
  assert.equal(s.merged.length, UNREADABLE_DEGRADED_LIMIT, "dispatches exactly up to the shared default, no further");
});

// ── acceptance 2: BEYOND the allowance, the single-lane drain stops distinguishably ──

test("single-lane: BEYOND the allowance the drain stops with a distinguishable reason instead of dispatching blind", async () => {
  const plan = fixturePlan();
  const merged = new Set<string>();
  const { log, lines } = recordingLog();
  const s = await runDrain(
    plan,
    {
      refreshMerged: () => (id) => merged.has(id),
      runOne: async (id) => { merged.add(id); return okResult(id); },
      readUsage: () => undefined,
      log,
    },
    { max: 10, unreadableDegradedLimit: 2 },
  );
  assert.equal(s.stopReason, "headroom_degraded");
  assert.notEqual(s.stopReason, "headroom_exhausted", "unreadable-too-long is distinct from a confirmed at-limit reading");
  assert.deepEqual(s.merged, ["A", "B"], "dispatched exactly through the allowance (limit 2), never a 3rd task");
  assert.match(s.stopDetail ?? "", /unreadable 3x consecutively \(limit 2\)/);
  assert.match(s.resumeCommand, /^rmd drain/, "a terminal StopReason still carries the existing resumeCommand");
  assert.ok(lines.includes("drain.headroom.degraded"), "the escalation is ledgered distinctly");
});

// ── acceptance 3: the multi-lane pass enforces the SAME ceiling ─────────────

test("multi-lane: BEYOND the allowance runDrainLanes stops too — both readUsage sites, one polarity", async () => {
  const plan = fixturePlan();
  const merged = new Set<string>();
  const s = await runDrain(
    plan,
    {
      refreshMerged: () => (id) => merged.has(id),
      runOne: async (id) => { merged.add(id); return okResult(id); },
      readUsage: () => undefined,
    },
    { max: 10, laneCount: 2, unreadableDegradedLimit: 2 },
  );
  assert.equal(s.stopReason, "headroom_degraded");
  // The counter advances once PER PASS (a tick), not once per co-dispatched task —
  // same semantics as the single-lane loop and the daemon. limit=2 ⇒ 2 passes of up
  // to 2 lanes each dispatch (4 tasks), the 3rd pass's pre-check stops before any lane runs.
  assert.deepEqual(s.merged.sort(), ["A", "B", "C", "D"]);
});

// ── acceptance 4: a single successful read resets the count to zero ─────────

test("a single successful read resets the consecutive-unreadable count to zero, exactly as the daemon's does", async () => {
  const plan = fixturePlan();
  const merged = new Set<string>();
  // undefined, undefined, GOOD, undefined, undefined, GOOD — 4 total misses, but never
  // more than 2 CONSECUTIVE, so a limit of 2 must never trip.
  const reads: Array<UsageSnapshot | undefined> = [
    undefined,
    undefined,
    HEALTHY_SNAPSHOT,
    undefined,
    undefined,
    HEALTHY_SNAPSHOT,
  ];
  let i = 0;
  const s = await runDrain(
    plan,
    {
      refreshMerged: () => (id) => merged.has(id),
      runOne: async (id) => { merged.add(id); return okResult(id); },
      readUsage: () => reads[i++],
    },
    { max: 6, unreadableDegradedLimit: 2 },
  );
  assert.equal(s.stopReason, "max_reached", "4 total misses would exceed limit=2 if the count were cumulative, not consecutive");
  assert.deepEqual(s.merged, ["A", "B", "C", "D", "E", "F"]);
});

// ── acceptance 5: governor DISABLED ⇒ absent telemetry, never a hold ────────

test("with headroomEnabled: false, an unreadable read never escalates — absent telemetry, not a hold (2026-07-28 ruling)", async () => {
  const plan = fixturePlan();
  const merged = new Set<string>();
  const { log, lines } = recordingLog();
  const s = await runDrain(
    plan,
    {
      refreshMerged: () => (id) => merged.has(id),
      runOne: async (id) => { merged.add(id); return okResult(id); },
      readUsage: () => undefined, // unreadable on EVERY tick, far past any bounded limit
      log,
    },
    { max: 6, unreadableDegradedLimit: 1, headroomEnabled: false },
  );
  assert.equal(s.stopReason, "max_reached", "disabled governor: no headroom_degraded, however many consecutive misses");
  assert.deepEqual(s.merged, ["A", "B", "C", "D", "E", "F"]);
  assert.ok(!lines.includes("drain.headroom.degraded"), "no escalation line — the ceiling never fires while disabled");
  assert.ok(!lines.includes("drain.headroom.unavailable"), "no telemetry line either — ABSENT, not just non-blocking");
});
