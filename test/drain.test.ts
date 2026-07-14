import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadPlan, type Plan } from "../src/lib/plan.js";
import type { RunResult } from "../src/run-task.js";
import type { UsageSnapshot } from "../src/lib/headroom.js";
import {
  nextRunnable,
  plannedSequence,
  renderSummary,
  resumeCommand,
  runDrain,
  type MergedSet,
} from "../src/lib/drain.js";

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
  const dir = mkdtempSync(join(tmpdir(), "drain-"));
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
const blockedResult = (id: string): RunResult => ({ taskId: id, runId: id + "-run", merged: false, costUsd: 0.3, verdict: "blocked_review", prUrl: "https://github.com/o/r/pull/9" });

// ── next-runnable = the DAG logic (reuses unmetDependencies) ────────────────

test("nextRunnable: first in file order whose deps are merged; skips verify:human and merged", () => {
  const plan = fixturePlan();
  // Nothing merged: A and D are runnable; A wins (file order). H (human) is skipped.
  assert.equal(nextRunnable(plan, NONE_MERGED)?.id, "A");
  // A merged: B and D runnable; B wins (file order before D).
  assert.equal(nextRunnable(plan, mergedSetOf("A"))?.id, "B");
  // A,B,C,D merged: only H left, and it is verify:human ⇒ nothing runnable.
  assert.equal(nextRunnable(plan, mergedSetOf("A", "B", "C", "D")), undefined);
});

test("plannedSequence (--dry-run order): simulates merges forward, honouring deps + --max + --until", () => {
  const plan = fixturePlan();
  assert.deepEqual(plannedSequence(plan, NONE_MERGED), ["A", "B", "C", "D"]);
  assert.deepEqual(plannedSequence(plan, NONE_MERGED, { max: 2 }), ["A", "B"]);
  assert.deepEqual(plannedSequence(plan, NONE_MERGED, { until: "B" }), ["A", "B"]);
  // --until already satisfied ⇒ empty.
  assert.deepEqual(plannedSequence(plan, mergedSetOf("A", "B"), { until: "B" }), []);
});

// ── the loop: stop-on-block, --max, headroom, until, no-runnable ────────────

test("stop-on-block: a blocked task HALTS the drain and does NOT run its dependents", async () => {
  const plan = fixturePlan();
  const merged = new Set<string>();
  const ran: string[] = [];
  const s = await runDrain(
    plan,
    {
      refreshMerged: () => (id) => merged.has(id),
      runOne: async (id) => {
        ran.push(id);
        // A merges; B blocks; C (B's dependent) must NEVER run.
        if (id === "B") return blockedResult(id);
        merged.add(id);
        return okResult(id);
      },
    },
  );
  assert.equal(s.stopReason, "blocked");
  assert.match(s.stopDetail ?? "", /B → blocked_review/);
  assert.deepEqual(s.merged, ["A"]);
  assert.deepEqual(ran, ["A", "B"]); // C was NOT attempted
  assert.ok(!ran.includes("C"), "the blocked task's dependent must not run");
  assert.match(s.resumeCommand, /^rmd drain/);
});

test("--max N halts after N successful tasks", async () => {
  const plan = fixturePlan();
  const merged = new Set<string>();
  const s = await runDrain(
    plan,
    {
      refreshMerged: () => (id) => merged.has(id),
      runOne: async (id) => { merged.add(id); return okResult(id); },
    },
    { max: 2 },
  );
  assert.equal(s.stopReason, "max_reached");
  assert.deepEqual(s.merged, ["A", "B"]);
  assert.equal(s.attempted.length, 2);
});

test("headroom: a near-limit reading STOPS with reason=headroom_exhausted BEFORE spawning", async () => {
  const plan = fixturePlan();
  const nearLimit: UsageSnapshot = {
    billingMode: "subscription",
    session: { percentUsed: 42, resetsAt: "3pm" },
    weekly: [{ label: "all models", percentUsed: 98, resetsAt: "Monday" }],
  };
  let spawned = 0;
  const s = await runDrain(
    plan,
    {
      refreshMerged: () => NONE_MERGED,
      runOne: async (id) => { spawned++; return okResult(id); },
      readUsage: () => nearLimit,
    },
  );
  assert.equal(s.stopReason, "headroom_exhausted");
  assert.match(s.stopDetail ?? "", /weekly \(all models\) at 98% — resets Monday/);
  assert.equal(spawned, 0, "no task is spawned when a window is at/near its limit");
});

test("headroom unreadable (undefined) does NOT halt — best-effort, the drain continues", async () => {
  const plan = fixturePlan();
  const merged = new Set<string>();
  const s = await runDrain(
    plan,
    {
      refreshMerged: () => (id) => merged.has(id),
      runOne: async (id) => { merged.add(id); return okResult(id); },
      readUsage: () => undefined,
    },
    { max: 1 },
  );
  assert.equal(s.stopReason, "max_reached");
  assert.deepEqual(s.merged, ["A"]);
});

test("--until: drains until the target merges, then stops", async () => {
  const plan = fixturePlan();
  const merged = new Set<string>();
  const s = await runDrain(
    plan,
    {
      refreshMerged: () => (id) => merged.has(id),
      runOne: async (id) => { merged.add(id); return okResult(id); },
    },
    { until: "B", max: 10 },
  );
  assert.equal(s.stopReason, "until_reached");
  assert.deepEqual(s.merged, ["A", "B"]); // C, D not run
});

test("no_runnable: an empty/blocked-out plan stops cleanly", async () => {
  const plan = fixturePlan();
  const s = await runDrain(
    plan,
    { refreshMerged: () => mergedSetOf("A", "B", "C", "D"), runOne: async (id) => okResult(id) },
  );
  assert.equal(s.stopReason, "no_runnable"); // only H left (verify:human)
  assert.deepEqual(s.attempted, []);
});

test("renderSummary + resumeCommand: 'what happened while away' is reconstructable", () => {
  const line = renderSummary({
    attempted: ["A", "B"], merged: ["A"], stopReason: "blocked",
    stopDetail: "B → blocked_review", costUsd: 0.8, resumeCommand: resumeCommand({ until: "C" }),
  });
  assert.match(line, /attempted : A, B/);
  assert.match(line, /merged    : A/);
  assert.match(line, /stopped   : blocked — B → blocked_review/);
  assert.match(line, /resume    : rmd drain --until C/);
});
