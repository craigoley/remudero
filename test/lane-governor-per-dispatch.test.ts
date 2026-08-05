/**
 * THE PER-LANE GOVERNOR GATE in `runDrainLanes` — the half W1-T342 did not reach.
 *
 * W1-T342 made the cost/queue governors per-DISPATCH in `runDaemon` because at N=1 per-tick and
 * per-dispatch coincide, and at N>1 one reading admits N dispatches. `runDrainLanes` still read the
 * governors once per PASS and then fired `Promise.allSettled(dispatchSet.map(...))`, so a ceiling
 * that tripped between lane 1 and lane 2 admitted lane 2 anyway.
 *
 * WHERE THE CHECK HAD TO GO, and why not inside the `.map`: `.map`'s callback runs SYNCHRONOUSLY for
 * every element, so N readings taken there all land in the same tick of the event loop, before any
 * lane has done any work — one reading wearing N hats. Admission is therefore a SEQUENTIAL loop that
 * takes its own reading per lane, and only the admitted subset reaches `allSettled`.
 *
 * WHAT THESE TESTS DRIVE, stated rather than implied: `runDrain` is the real production entry point
 * and `runDrainLanes` is reached through it by `laneCount: 2` — no seam, no injection of the gate
 * itself. `checkCostGovernor`/`checkQueueGovernor` ARE injected, because they are `DrainDeps` fields
 * with no production default (the real wiring supplies `costGovernorGateFor`/`queueGovernorGateFor`
 * from run-task.ts). So the DECISION and the loop are production code; the observations are fixtures.
 * LEFT UNPROVEN, named: the run-task.ts wiring that supplies those two deps to a LANE pass does not
 * exist yet — `daemonCommand` passes no `laneCount`, and W1-T343 is the task that will. Until it
 * lands, no production caller reaches this loop with N>=2.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runDrain, type DrainDeps, type MergedSet } from "../src/lib/drain.js";
import { loadPlan, type Plan } from "../src/lib/plan.js";

const NONE_MERGED: MergedSet = () => false;

/**
 * Two runnable tasks with DISJOINT `files:`, so `partitionByFileOverlap` puts BOTH in the concurrent
 * dispatch set rather than serialising them. Built through the REAL `loadPlan` — a hand-built
 * `{tasks, byId}` literal does not satisfy `isDispatchEligible` and silently yields an empty
 * candidate set (measured: dispatched = []), which would make every assertion here vacuous.
 */
function twoLanePlan(): Plan {
  const dir = mkdtempSync(join(tmpdir(), "rmd-lane-governor-"));
  const f = join(dir, "tasks.yaml");
  writeFileSync(
    f,
    "- id: A\n  title: a\n  repo: remudero\n  type: implement\n  depends_on: []\n  status: queued\n  files: [src/a.ts]\n" +
      "- id: B\n  title: b\n  repo: remudero\n  type: implement\n  depends_on: []\n  status: queued\n  files: [src/b.ts]\n",
  );
  return loadPlan(f);
}

function laneDeps(over: Partial<DrainDeps> = {}): DrainDeps & { dispatched: string[]; steps: string[] } {
  const dispatched: string[] = [];
  const steps: string[] = [];
  const deps = {
    refreshMerged: () => NONE_MERGED,
    log: (step: string) => steps.push(step),
    runOne: async (id: string) => {
      dispatched.push(id);
      return { taskId: id, runId: `R-${id}`, merged: true, costUsd: 1, verdict: "merged" as const };
    },
    ...over,
  } as DrainDeps & { dispatched: string[]; steps: string[] };
  deps.dispatched = dispatched;
  deps.steps = steps;
  return deps;
}

// ── TWO LANES CONSULT THE GOVERNOR INDEPENDENTLY ─────────────────────────────────────────────

test("each lane takes its OWN governor reading — two admissions, two calls, never one reading for both", async () => {
  let costCalls = 0;
  const deps = laneDeps({
    checkCostGovernor: () => {
      costCalls++;
      return undefined; // always admits
    },
  });
  const summary = await runDrain(twoLanePlan(), deps, { laneCount: 2, max: 2 });

  assert.deepEqual(deps.dispatched.sort(), ["A", "B"], "both lanes dispatched");
  // One pass-level read gates the pass; then ONE PER ADMITTED LANE. The old code took the pass-level
  // read only, so this count was 1 no matter how many lanes were admitted.
  assert.ok(costCalls >= 3, `expected >=3 readings (1 pass-level + 1 per lane), got ${costCalls}`);
  assert.notEqual(summary.stopReason, "cost_governor_deferred");
});

test("a governor that trips between lane 1 and lane 2 refuses lane 2 and admits lane 1", async () => {
  // The exact defect: the pass-level reading admits, lane 1's reading admits, and the ceiling is
  // crossed before lane 2's reading. Under the old code lane 2 dispatched on lane 1's verdict.
  let reads = 0;
  const deps = laneDeps({
    checkCostGovernor: () => {
      reads++;
      // reads 1 (pass-level) and 2 (lane 1) admit; read 3 (lane 2) is over the ceiling.
      return reads >= 3 ? { deferred: true, observedDayCostUsd: 206, ceilingUsd: 150 } : undefined;
    },
  });
  const summary = await runDrain(twoLanePlan(), deps, { laneCount: 2, max: 2 });

  assert.equal(deps.dispatched.length, 1, "exactly one lane was admitted");
  assert.equal(summary.attempted.length, 1, "and only the admitted lane is counted as attempted");
});

// ── A MID-PASS REFUSAL MUST NOT ABORT THE PASS ───────────────────────────────────────────────

test("a mid-pass refusal does not abort the pass — the admitted lane still runs and its outcome is recorded", async () => {
  let reads = 0;
  const deps = laneDeps({
    checkCostGovernor: () => {
      reads++;
      return reads >= 3 ? { deferred: true, observedDayCostUsd: 206, ceilingUsd: 150 } : undefined;
    },
  });
  const summary = await runDrain(twoLanePlan(), deps, { laneCount: 2, max: 2 });

  assert.equal(deps.dispatched.length, 1, "lane 1 ran");
  assert.deepEqual(summary.merged, deps.dispatched, "and its MERGED outcome was recorded, not discarded");
  assert.notEqual(summary.stopReason, "lane_error", "refusing lane 2 is a deferral, never a failure of lane 1");
});

test("EVERY lane refused reports a governor deferral, not no_runnable — there WERE runnable tasks", async () => {
  const deps = laneDeps({
    checkCostGovernor: () => ({ deferred: true, observedDayCostUsd: 206, ceilingUsd: 150 }),
  });
  const summary = await runDrain(twoLanePlan(), deps, { laneCount: 2, max: 2 });
  assert.equal(deps.dispatched.length, 0);
  assert.equal(summary.stopReason, "cost_governor_deferred");
  assert.notEqual(summary.stopReason, "no_runnable", "no_runnable would misreport a governed pass as an empty queue");
});

test("an UNREADABLE observation fails closed for the later lane — a throw is a deferral, never a crash", async () => {
  // The gate wraps both governor calls in try/catch and returns kind:"unreadable", so a throw taken
  // at LANE-ADMISSION time is a deferral of that lane rather than an escape out of runDrain.
  //
  // SCOPED TO THE ONE THROW DELIBERATELY (`reads === 3`, not `>= 3`). The PASS-LEVEL reads far above
  // the lane loop are still BARE — `deps.checkCostGovernor?.()` with no try/catch — so a throw taken
  // THERE still propagates out of runDrain. That is pre-existing (W1-T342 wrapped runDaemon's calls,
  // never drain.ts's) and is OUT OF SCOPE here: wrapping it is a second concern with its own
  // fail-closed semantics to argue. Measured while writing this test: with `>= 3` the next pass's
  // pass-level read threw and escaped, which is exactly that gap and not this gate's.
  let reads = 0;
  const deps = laneDeps({
    checkCostGovernor: () => {
      reads++;
      if (reads === 3) throw new Error("ledger read failed mid-batch");
      return undefined;
    },
  });
  // max: 2 so TWO lanes reach the admission loop in one pass. (`max: 1` sizes the candidate set to a
  // single task, so there is no second lane to refuse and the throw is never reached — measured.)
  const summary = await runDrain(twoLanePlan(), deps, { laneCount: 2, max: 2 });

  assert.ok(summary, "the pass returned a summary rather than letting the throw escape runDrain");
  // THE DISCRIMINATING ASSERTION, and the reason it is the gate's ledger step rather than a dispatch
  // count: a count assertion passed with the gate REVERTED during the falsifier run, because `max`
  // bounds dispatch on its own. Only the gate can emit this step.
  assert.ok(
    deps.steps.includes("dispatch.lane_governed"),
    "the per-lane gate must ledger its refusal — a count alone passes on a reverted gate",
  );
});

test("the QUEUE governor is consulted per lane too, not only the cost one", async () => {
  let queueReads = 0;
  const deps = laneDeps({
    checkCostGovernor: () => undefined,
    checkQueueGovernor: () => {
      queueReads++;
      return queueReads >= 3 ? { deferred: true, observedOpenCount: 30, wipLimit: 4 } : undefined;
    },
  });
  const summary = await runDrain(twoLanePlan(), deps, { laneCount: 2, max: 2 });
  assert.equal(deps.dispatched.length, 1, "the WIP ceiling crossing refused the second lane");
  assert.ok(summary);
});

// ── THE REGRESSION LOCK — a governor that blocks everything passes the tests above ────────────
//
// A gate that refuses when it should admit breaks the fleet and would satisfy every "it refused"
// assertion above. These are the tests that matter more than the feature.

test("REGRESSION LOCK: a healthy pass with NO governors wired dispatches every lane", async () => {
  // Both governor deps ABSENT — the shape a caller that predates the governors has. The optional
  // calls must degrade to "admitted", never to "refused".
  const deps = laneDeps();
  const summary = await runDrain(twoLanePlan(), deps, { laneCount: 2, max: 2 });
  assert.deepEqual(deps.dispatched.sort(), ["A", "B"], "no governors ⇒ nothing is refused");
  assert.deepEqual(summary.merged.sort(), ["A", "B"]);
  assert.notEqual(summary.stopReason, "cost_governor_deferred");
});

test("REGRESSION LOCK: governors wired and ADMITTING dispatch every lane — the gate is not a blanket refusal", async () => {
  const deps = laneDeps({
    checkCostGovernor: () => undefined,
    checkQueueGovernor: () => undefined,
  });
  const summary = await runDrain(twoLanePlan(), deps, { laneCount: 2, max: 2 });
  assert.deepEqual(deps.dispatched.sort(), ["A", "B"], "an admitting governor admits BOTH lanes");
  assert.deepEqual(summary.merged.sort(), ["A", "B"]);
});

test("REGRESSION LOCK: the single-lane path is untouched — laneCount 1 still dispatches", async () => {
  const deps = laneDeps({ checkCostGovernor: () => undefined });
  const summary = await runDrain(twoLanePlan(), deps, { laneCount: 1, max: 1 });
  assert.equal(deps.dispatched.length, 1, "N=1 goes through runDrain's own loop, not runDrainLanes");
  assert.notEqual(summary.stopReason, "cost_governor_deferred");
});
