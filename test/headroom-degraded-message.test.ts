/**
 * The `headroom_degraded` stop detail must not assert a stage the drain cannot see.
 *
 * MEASURED, TWICE IN ONE EVENING: two consecutive containerised drains stopped with
 * `headroom_degraded — usage unreadable 4x consecutively (limit 3)`, each surrendering the rest of
 * a `--max 6` budget. "unreadable" pointed the operator at a broken API. The drain cannot know
 * that: `readUsage` is `() => readUsageSnapshot(config)` at BOTH call sites (src/run-task.ts), and
 * that function distinguishes `"spawn"` from `"parse"` (`UsageProbeFailureStage`) — its own comment
 * records that conflating the two "cost this fleet its headroom read for hours on 2026-07-31",
 * when a perfect 1015-byte read was thrown away by the PARSER. Both branches return `undefined`,
 * so one bit reaches the drain and the stage is gone.
 *
 * `ledgerUsageProbeFailure` already writes `usage.probe_failed` durably with the stage and reason.
 * So the detail now POINTS AT THAT ROW instead of guessing. The bound is untouched — the read
 * genuinely failed and the ceiling behaved correctly on a true input — and so is the no-signal
 * polarity, which `readUsageSnapshot`'s doc calls ratified and not its to change.
 *
 * BOTH DIRECTIONS, because a test that only checks the failing wording would pass against a change
 * that emitted it unconditionally: a HEALTHY read must produce no degraded stop and no such
 * sentence anywhere. And BOTH SITES, because W1-T290 shipped this ceiling to `runDrain`'s
 * single-lane loop AND `runDrainLanes`' multi-lane pass precisely so `--lanes` did not stay a
 * latent fail-open; a fix to one is a fix to half.
 *
 * Its own file per CLAUDE.md's coverage rule.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadPlan, type Plan } from "../src/lib/plan.js";
import type { RunResult } from "../src/run-task.js";
import type { UsageSnapshot } from "../src/lib/headroom.js";
import { headroomDegradedDetail, runDrain } from "../src/lib/drain.js";

const YAML = ["A", "B", "C", "D", "E", "F"]
  .map((id) => `- id: ${id}\n  title: ${id}\n  repo: remudero\n  type: implement\n  depends_on: []\n  status: queued\n  files: [src/${id.toLowerCase()}.ts]\n`)
  .join("");

/** Six independent tasks with disjoint `files:`, so neither `nextRunnable` nor the lanes pass's
 *  file-overlap partition can stop the drain for `no_runnable` — the ceiling is the only thing
 *  under test. Same fixture shape as test/drain-unreadable-degraded.test.ts. */
function fixturePlan(): Plan {
  const dir = mkdtempSync(join(tmpdir(), "headroom-degraded-message-"));
  const f = join(dir, "tasks.yaml");
  writeFileSync(f, YAML);
  return loadPlan(f);
}

const okResult = (id: string): RunResult => ({
  taskId: id,
  runId: id + "-run",
  merged: true,
  costUsd: 0.1,
  verdict: "merged",
});

/** Comfortably under any limit — a good read, never `headroom_exhausted`. */
const HEALTHY: UsageSnapshot = {
  billingMode: "subscription",
  session: { percentUsed: 10 },
  weekly: [{ label: "all models", percentUsed: 20 }],
};

async function drain(readUsage: () => UsageSnapshot | undefined, lanes?: number) {
  const plan = fixturePlan();
  const merged = new Set<string>();
  const steps: string[] = [];
  const s = await runDrain(
    plan,
    {
      refreshMerged: () => (id) => merged.has(id),
      runOne: async (id) => {
        merged.add(id);
        return okResult(id);
      },
      readUsage,
      log: (step: string) => steps.push(step),
    },
    { max: 6, unreadableDegradedLimit: 1, ...(lanes ? { lanes } : {}) },
  );
  return { summary: s, steps };
}

// ── the pure detail ──────────────────────────────────────────────────────────

test("the detail names the ledger row and BOTH stages, and never asserts that the read was unreadable", () => {
  const d = headroomDegradedDetail(4, 3);
  assert.match(d, /usage\.probe_failed/, "it must name the row that actually holds the answer");
  assert.match(d, /spawn/);
  assert.match(d, /parse/, "naming only one stage would reintroduce the guess this fixes");
  assert.match(d, /4x consecutively \(limit 3\)/, "the counts an operator needs are still there");
  assert.doesNotMatch(d, /unreadable/, "the drain cannot see that a read was unreadable rather than unparseable");
});

// ── direction 1: a failing probe says so, at BOTH sites ──────────────────────

test("single-lane: a failing probe stops with a detail pointing at usage.probe_failed", async () => {
  const { summary, steps } = await drain(() => undefined);
  assert.equal(summary.stopReason, "headroom_degraded", "the fixture must reach the ceiling, or the rest is vacuous");
  assert.equal(summary.stopDetail, headroomDegradedDetail(2, 1), "the site calls the shared builder, not a hand-copied sentence");
  assert.match(String(summary.stopDetail), /usage\.probe_failed/);
  assert.doesNotMatch(String(summary.stopDetail), /unreadable/);
  assert.ok(steps.includes("drain.headroom.degraded"), "and the terminal ledger line is still written");
});

test("multi-lane: the SAME detail comes out of runDrainLanes, so --lanes is not fixed by half", async () => {
  const { summary } = await drain(() => undefined, 2);
  assert.equal(summary.stopReason, "headroom_degraded");
  assert.match(String(summary.stopDetail), /usage\.probe_failed/, "the lanes pass must carry the corrected wording too");
  assert.doesNotMatch(String(summary.stopDetail), /unreadable/);
});

// ── direction 2: a healthy probe says NOTHING ────────────────────────────────

test("a HEALTHY read produces no degraded stop and no such sentence — the control", async () => {
  // Differs in ONE variable: the probe answers. A change that emitted the new wording
  // unconditionally would pass the two tests above and fail here.
  const { summary, steps } = await drain(() => HEALTHY);
  assert.equal(summary.stopReason, "max_reached", "a healthy read must not stop the drain");
  // `max_reached` carries its OWN detail ("6 task(s)") — the claim is that the DEGRADED sentence is
  // absent, not that there is no detail at all. Asserting emptiness here was wrong and this control
  // caught it, which is the argument for keeping the control rather than trimming it.
  assert.doesNotMatch(String(summary.stopDetail ?? ""), /usage\.probe_failed|probe failed/);
  assert.equal(steps.includes("drain.headroom.degraded"), false, "no degraded line on a healthy read");
  assert.equal(steps.includes("drain.headroom.unavailable"), false, "and no allowance line either");
});

// ── the falsifier ────────────────────────────────────────────────────────────

test("MUTANT: the wording lives in ONE builder, and both stop sites call it", () => {
  const src = readFileSync(new URL("../src/lib/drain.ts", import.meta.url), "utf8");

  const decl = "export function headroomDegradedDetail(";
  assert.equal(src.split(decl).length - 1, 1, "the substitution target must be UNIQUE or the mutant proves nothing");

  const call = "headroomDegradedDetail(consecutiveUnreadable, unreadableDegradedLimit)";
  assert.equal(src.split(call).length - 1, 2, "BOTH the single-lane and the lanes stop must call it");

  // The old sentence is what an operator read for two drains; asserting its absence is what makes
  // a revert fail rather than merely un-improve.
  assert.equal(src.includes("usage unreadable"), false, "no site may still assert a stage the drain cannot see");
});
