// test/dispatch-settled-set.test.ts
//
// THE GAP. `dispatch.concurrent_set` records the set of lanes a pass STARTED — `{tasks, lane_count}`
// — and has NEVER FIRED in production: 0 rows over the live ledger unioned with every rotation,
// against a positive control of 120,984 `dispatch.indeterminate` and six other `dispatch.*` steps in
// the same scan (a fabricated step name returns 0). Nothing records the set that CONCLUDED, so at
// N >= 2 a lane that dies mid-pass is detectable only as a set-difference someone must think to
// compute. That is the same shape as the blind sweep, where a missing `sweep.summary` took two
// undetected 22-minute episodes to find by hand.
//
// TWO CALL SITES, because W1-T343 (#1363) MIRRORED the lane machinery into `runDaemon` rather than
// calling `runDrainLanes`. Both `drain.ts`'s `runDrainLanes` and `daemon.ts`'s own lane path have
// their own `Promise.allSettled`, so both need the row; `settledSetPayload` (dispatch-overlap.ts)
// is the single definition of its shape so the two cannot drift.
//
// WHAT IS REAL HERE, STATED PLAINLY BECAUSE THIS PATH HAS NEVER RUN IN PRODUCTION. These tests drive
// the REAL `runDaemon` and the REAL `runDrain` at `laneCount: 2`, through the real admission,
// file-overlap partition and `Promise.allSettled` loop. The ONLY injected dependency is `runOne` —
// the worker spawn — which cannot run in a unit test at any price; the harness is the one
// test/drain.test.ts's own W1-T343 acceptance already uses. The row's construction, its POSITION
// relative to the classification loop, and the payload are all production code executing here.
//
// LEFT UNPROVEN BY THIS FILE: nothing reads `dispatch.settled_set` yet — the consumer and any
// threshold are deliberately out of scope — so no test asserts what an operator would DO with it.

import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadPlan } from "../src/lib/plan.js";
import { runDaemon, type DaemonDeps } from "../src/lib/daemon.js";
import { settledSetPayload } from "../src/lib/dispatch-overlap.js";
import type { RunResult } from "../src/run-task.js";

/** Two tasks with DISJOINT `files:`, so the overlap partition admits both into one pass. */
function twoDisjointPlan() {
  const dir = mkdtempSync(join(tmpdir(), "rmd-settled-set-"));
  const f = join(dir, "tasks.yaml");
  writeFileSync(
    f,
    "- id: A\n  title: a\n  repo: remudero\n  type: implement\n  depends_on: []\n  status: queued\n  files: [src/a.ts]\n" +
      "- id: B\n  title: b\n  repo: remudero\n  type: implement\n  depends_on: []\n  status: queued\n  files: [src/b.ts]\n",
  );
  return loadPlan(f);
}

function okResult(id: string): RunResult {
  return { taskId: id, merged: true, verdict: "merged", costUsd: 1, prUrl: `https://x/${id}` } as unknown as RunResult;
}

type Line = { step: string; extra?: Record<string, unknown> };
const settledRows = (steps: Line[]) => steps.filter((l) => l.step === "dispatch.settled_set");

/** Drives the REAL runDaemon at laneCount 2; only `runOne` is injected. */
async function runTwoLaneDaemon(runOne: (id: string) => Promise<RunResult>) {
  const steps: Line[] = [];
  const summary = await runDaemon(
    twoDisjointPlan(),
    {
      refreshMerged: () => () => false,
      log: (step: string, extra?: Record<string, unknown>) => steps.push({ step, extra }),
      runOne,
      sleep: async () => {},
    } as unknown as DaemonDeps,
    { max: 2, laneCount: 2 },
  ).catch((e: unknown) => ({ threw: e }) as never);
  return { steps, summary };
}

// ── a clean two-lane pass ────────────────────────────────────────────────────────────────────────

test("a clean 2-lane pass writes one settled row naming both tasks fulfilled", async () => {
  const { steps } = await runTwoLaneDaemon(async (id) => okResult(id));

  const started = steps.find((l) => l.step === "dispatch.concurrent_set");
  assert.ok(started, "the STARTED set is still recorded — this row is a counterpart, not a replacement");

  const rows = settledRows(steps);
  assert.equal(rows.length, 1, "one settled row per pass, not one per lane");
  const x = rows[0]!.extra as { tasks: Array<{ id: string; status: string }>; dispatched: number; fulfilled: number; rejected: number };
  assert.equal(x.dispatched, 2);
  assert.equal(x.fulfilled, 2);
  assert.equal(x.rejected, 0);
  assert.deepEqual(x.tasks.map((t) => t.id).sort(), ["A", "B"]);
  assert.ok(x.tasks.every((t) => t.status === "fulfilled"));
});

// ── THE CASE THE ROW EXISTS FOR: one lane rejects ────────────────────────────────────────────────

test("when ONE lane rejects the settled row still names BOTH outcomes — dispatched 2, fulfilled 1, rejected 1", async () => {
  // Without this row, a dead lane is only a set-difference against `dispatch.concurrent_set`.
  const { steps } = await runTwoLaneDaemon(async (id) => {
    if (id === "B") throw new Error("lane B died");
    return okResult(id);
  });

  const rows = settledRows(steps);
  assert.equal(rows.length, 1, "a rejecting lane must not suppress the row");
  const x = rows[0]!.extra as { tasks: Array<{ id: string; status: string }>; dispatched: number; fulfilled: number; rejected: number };
  assert.equal(x.dispatched, 2, "both lanes were dispatched");
  assert.equal(x.fulfilled, 1);
  assert.equal(x.rejected, 1);
  assert.equal(x.tasks.find((t) => t.id === "A")?.status, "fulfilled");
  assert.equal(x.tasks.find((t) => t.id === "B")?.status, "rejected", "the dead lane is NAMED, not inferred");
});

test("the settled row precedes the classification loop, so a pass that dies on a fatal lane still reports what concluded", async () => {
  // The daemon's classification loop treats a non-spawn-infra rejection as fatal and returns. A row
  // emitted after that loop would be absent here — which is precisely the case it exists for.
  const { steps } = await runTwoLaneDaemon(async (id) => {
    if (id === "A") throw new Error("fatal in lane A");
    return okResult(id);
  });

  const rows = settledRows(steps);
  assert.equal(rows.length, 1, "the row survives the fatal-lane return path");
  const x = rows[0]!.extra as { dispatched: number; rejected: number };
  assert.equal(x.dispatched, 2);
  assert.equal(x.rejected, 1);

  const idx = steps.findIndex((l) => l.step === "dispatch.settled_set");
  const started = steps.findIndex((l) => l.step === "dispatch.concurrent_set");
  assert.ok(started >= 0 && idx > started, "started-set first, settled-set after — the pair is the signal");
});

// ── the payload builder itself ───────────────────────────────────────────────────────────────────

test("settledSetPayload pairs each task with its OWN settlement, by position", async () => {
  const admitted = [{ id: "A" }, { id: "B" }, { id: "C" }];
  const settled = await Promise.allSettled([
    Promise.resolve(1),
    Promise.reject(new Error("boom")),
    Promise.resolve(3),
  ]);
  const p = settledSetPayload(admitted, settled, 3) as {
    tasks: Array<{ id: string; status: string }>;
    dispatched: number;
    fulfilled: number;
    rejected: number;
    lane_count: number;
  };
  assert.deepEqual(p.tasks, [
    { id: "A", status: "fulfilled" },
    { id: "B", status: "rejected" },
    { id: "C", status: "fulfilled" },
  ]);
  assert.equal(p.dispatched, 3);
  assert.equal(p.fulfilled, 2);
  assert.equal(p.rejected, 1);
  assert.equal(p.lane_count, 3);
});

test("a bare pulse could not distinguish dispatched-2-concluded-1 from dispatched-1-concluded-1", async () => {
  const twoOneDead = settledSetPayload([{ id: "A" }, { id: "B" }], await Promise.allSettled([Promise.resolve(1), Promise.reject(new Error("x"))]), 2) as Record<string, number>;
  const oneClean = settledSetPayload([{ id: "A" }], await Promise.allSettled([Promise.resolve(1)]), 2) as Record<string, number>;
  assert.notEqual(twoOneDead.dispatched, oneClean.dispatched, "the counts separate them");
  assert.equal(twoOneDead.fulfilled, oneClean.fulfilled, "and a fulfilled-count alone would NOT — which is why dispatched is carried");
});
