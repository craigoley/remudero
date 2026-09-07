import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadPlan, type Plan } from "../src/lib/plan.js";
import type { RunResult } from "../src/run-task.js";
import { runDaemon } from "../src/lib/daemon.js";
import { drainDetachedSweepActions } from "../src/lib/sweep.js";
import type { MergedSet } from "../src/lib/drain.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";

// W1-T2986 — A FIRED TRIAGE MUST NOT HOLD THE DISPATCH RUNG.
//
// The auto-triage rung sits between the dispatch-set computation and the idle branch and awaited an
// unbounded run wrapped in a light-sweep ticker — the exact shape W1-T2981 removed from the retro
// beside it, and the shape that took the fleet down for two days: the ticker keeps reviewing and
// merging, so every liveness signal stays green while the one rung that builds is never reached.
// MEASURED across the ledger union: 185 `auto_triage.fired` against 1241 `auto_triage.skipped`, so
// roughly one tick in eight would stall here once the retro no longer stalled first.

const YAML = `
- id: A
  title: a
  repo: remudero
  type: implement
  depends_on: []
  status: queued
`;

function fixturePlan(): Plan {
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}t2986-`));
  const f = join(dir, "tasks.yaml");
  writeFileSync(f, YAML);
  return loadPlan(f);
}

const okResult = (id: string): RunResult => ({
  taskId: id, runId: id + "-run", merged: true, costUsd: 0, verdict: "merged",
});

test("W1-T2986: a fired triage does not hold the tick, so dispatch still runs", async () => {
  const plan = fixturePlan();
  const merged = new Set<string>();
  const lines: Array<{ step: string }> = [];
  let releaseTriage: () => void = () => {};
  // A triage that never settles on its own: the claim is that the tick reaches dispatch ANYWAY, so
  // the fixture must not be able to pass by the triage simply finishing quickly.
  const blocked = new Promise<void>((resolve) => { releaseTriage = resolve; });

  const s = await runDaemon(plan, {
    refreshMerged: () => ((id: string) => merged.has(id)) as MergedSet,
    runOne: async (id) => { merged.add(id); return okResult(id); },
    sleep: async () => {},
    log: (step) => lines.push({ step }),
    checkAutoTriage: () => ({ fire: true, feedbackId: "fb-1", reason: "starved" }) as never,
    runAutoTriage: async () => { await blocked; },
  }, { max: 1 });

  assert.ok(lines.some((l) => l.step === "auto_triage.fired"), "the triage really did fire");
  assert.ok(lines.some((l) => l.step === "auto_triage.detached"), "and it was detached rather than awaited");
  assert.deepEqual(
    s.attempted,
    ["A"],
    "THE CLAIM: dispatch was reached while the triage was still in flight. Before this task the " +
      "tick blocked here and attempted nothing.",
  );

  releaseTriage();
  await drainDetachedSweepActions({ boundMs: 5000 });
});

test("W1-T2986: a second triage is refused while one is still detached", async () => {
  const plan = fixturePlan();
  const lines: Array<{ step: string }> = [];
  let releaseTriage: () => void = () => {};
  const blocked = new Promise<void>((resolve) => { releaseTriage = resolve; });
  let started = 0;
  let ticks = 0;

  await runDaemon(plan, {
    refreshMerged: () => (() => true) as MergedSet,
    runOne: async (id) => okResult(id),
    sleep: async () => {},
    log: (step) => lines.push({ step }),
    checkAutoTriage: () => ({ fire: true, feedbackId: "fb-1", reason: "starved" }) as never,
    runAutoTriage: async () => { started += 1; await blocked; },
    checkStop: () => (++ticks >= 4 ? { reason: "test done" } as never : undefined),
  });

  assert.equal(started, 1, "exactly ONE triage ran — a second would duplicate its PR");
  assert.ok(
    lines.some((l) => l.step === "auto_triage.already_detached"),
    "and the refusal is named in the ledger, never a silent skip",
  );

  releaseTriage();
  await drainDetachedSweepActions({ boundMs: 5000 });
});
