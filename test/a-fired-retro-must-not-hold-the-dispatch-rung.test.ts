import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadPlan, type Plan } from "../src/lib/plan.js";
import type { RunResult } from "../src/run-task.js";
import { runDaemon } from "../src/lib/daemon.js";
import { drainDetachedSweepActions, detachedActionInFlight } from "../src/lib/sweep.js";
import type { MergedSet } from "../src/lib/drain.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";

// W1-T2981 — A FIRED RETRO MUST NOT HOLD THE DISPATCH RUNG.
//
// The retro rung sits ABOVE the dispatch pick and used to `await` an unbounded run. MEASURED on the
// fleet 2026-09-06: the tick logged `retro_triggered` at 19:47:39 and from then on wrote no
// `daemon.idle` and no dispatch row at all, while the light sweep kept reviewing and merging — so
// every liveness signal stayed green and the fleet built nothing. With the retro marker 3.7 days and
// 446 merges behind against `RETRO_MAX_RUNS_PER_PASS` of 40, that is ~11 retro-only ticks in a row.
//
// A retro gates nothing: it spends (hence its place below the headroom rung), but no rung downstream
// reads its result, so the loop has no reason to wait on it.

const YAML = `
- id: A
  title: a
  repo: remudero
  type: implement
  depends_on: []
  status: queued
`;

function fixturePlan(): Plan {
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}t2971-`));
  const f = join(dir, "tasks.yaml");
  writeFileSync(f, YAML);
  return loadPlan(f);
}

const okResult = (id: string): RunResult => ({
  taskId: id, runId: id + "-run", merged: true, costUsd: 0, verdict: "merged",
});

test("W1-T2981: a fired retro does not hold the tick, so dispatch still runs", async () => {
  const plan = fixturePlan();
  const merged = new Set<string>();
  const mergedSet: MergedSet = (id) => merged.has(id);
  const lines: Array<{ step: string }> = [];
  let releaseRetro: () => void = () => {};
  // A retro that NEVER settles on its own. Before this task that was a permanent stall; the whole
  // claim is that the tick reaches dispatch anyway, so the fixture must not be able to pass by the
  // retro simply finishing quickly.
  const retroBlocked = new Promise<void>((resolve) => { releaseRetro = resolve; });
  let ticks = 0;

  const s = await runDaemon(plan, {
    refreshMerged: () => mergedSet,
    runOne: async (id) => { merged.add(id); return okResult(id); },
    sleep: async () => {},
    log: (step) => lines.push({ step }),
    checkRetroTrigger: () => ({ fire: ticks++ === 0, reason: "merges", mergesSinceMarker: 446, daysSinceMarker: 3.7 }),
    runRetroTrigger: async () => { await retroBlocked; },
    checkStop: () => (ticks >= 3 ? { reason: "test done" } as never : undefined),
  });

  assert.ok(
    lines.some((l) => l.step === "retro_triggered"),
    "the retro really did fire — otherwise this test proves nothing about a fired one",
  );
  assert.ok(
    lines.some((l) => l.step === "daemon.retro_trigger.detached"),
    "and it was detached rather than awaited",
  );
  assert.deepEqual(
    s.attempted,
    ["A"],
    "THE CLAIM: the tick reached the dispatch rung while the retro was still running. Before " +
      "W1-T2981 this was empty and no dispatch row was ever written.",
  );

  releaseRetro();
  await drainDetachedSweepActions({ boundMs: 5000 });
});

test("W1-T2981: a second retro is refused while one is still detached", async () => {
  const plan = fixturePlan();
  const lines: Array<{ step: string }> = [];
  let releaseRetro: () => void = () => {};
  const retroBlocked = new Promise<void>((resolve) => { releaseRetro = resolve; });
  let ticks = 0;
  let started = 0;

  await runDaemon(plan, {
    refreshMerged: () => () => true,
    runOne: async (id) => okResult(id),
    sleep: async () => {},
    log: (step) => lines.push({ step }),
    // Fires on EVERY tick — the marker is far enough behind that the real trigger would too.
    checkRetroTrigger: () => ({ fire: true, reason: "merges", mergesSinceMarker: 446, daysSinceMarker: 3.7 }),
    runRetroTrigger: async () => { started += 1; await retroBlocked; },
    checkStop: () => (++ticks >= 4 ? { reason: "test done" } as never : undefined),
  });

  assert.equal(started, 1, "exactly ONE retro ran — a second would race the same marker file");
  assert.ok(
    lines.filter((l) => l.step === "daemon.retro_trigger.already_detached").length >= 1,
    "and the refusal is named in the ledger, never a silent skip",
  );

  releaseRetro();
  await drainDetachedSweepActions({ boundMs: 5000 });
  assert.equal(detachedActionInFlight("retro"), false, "the registry is empty once the retro settles");
});
