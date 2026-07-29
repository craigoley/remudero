import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadPlan, type Plan } from "../src/lib/plan.js";
import type { RunResult } from "../src/run-task.js";
import { laneDispatchBudget, runDrain } from "../src/lib/drain.js";

/**
 * W1-T172 PARALLEL DISPATCH — N concurrent lanes bounded by the queue
 * governor's WIP limit, over the sharded plan, with W1-T80's open-PR dedup
 * and W1-T149's circuit breaker reused (never reimplemented) as per-task
 * guards, and W1-T171's file-overlap check applied ACROSS the co-dispatched
 * set. See src/lib/drain.ts's `runDrainLanes` for the implementation this
 * file proves.
 *
 * Fixture: four independent tasks (no depends_on, so every one of them is a
 * candidate every pass) with DISJOINT `files:` — except D, which deliberately
 * OVERLAPS A — so the overlap partition (W1-T171) has something real to bite
 * on within a lane pass, distinct from the governor/guard tests that need
 * disjoint candidates to isolate what they're each proving.
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
  files: [src/a.ts]
`;

function fixturePlan(): Plan {
  const dir = mkdtempSync(join(tmpdir(), "parallel-dispatch-"));
  const f = join(dir, "tasks.yaml");
  writeFileSync(f, YAML);
  return loadPlan(f);
}

const okResult = (id: string): RunResult => ({ taskId: id, runId: id + "-run", merged: true, costUsd: 0.1, verdict: "merged" });
const blockedResult = (id: string): RunResult => ({
  taskId: id,
  runId: id + "-run",
  merged: false,
  costUsd: 0.1,
  verdict: "blocked_review",
  prUrl: "https://github.com/o/r/pull/9",
});

// ── laneDispatchBudget: the pure governor-ceiling math ──────────────────────

test("laneDispatchBudget: bounded by laneCount alone when the governor is un-wired (wipLimit/openPrCount omitted)", () => {
  assert.equal(laneDispatchBudget({ laneCount: 2 }), 2);
  assert.equal(laneDispatchBudget({ laneCount: 0 }), 0);
});

test("laneDispatchBudget: min(laneCount, headroom under wipLimit) — THE GOVERNOR IS THE CEILING, NOT A SUGGESTION", () => {
  assert.equal(laneDispatchBudget({ laneCount: 2, wipLimit: 10, openPrCount: 3 }), 2, "ample headroom ⇒ laneCount wins");
  assert.equal(laneDispatchBudget({ laneCount: 2, wipLimit: 10, openPrCount: 9 }), 1, "headroom=1 caps BELOW laneCount");
  assert.equal(
    laneDispatchBudget({ laneCount: 2, wipLimit: 10, openPrCount: 10 }),
    0,
    "at the limit ⇒ zero — collapses exactly like the single-lane governor",
  );
  assert.equal(laneDispatchBudget({ laneCount: 2, wipLimit: 10, openPrCount: 20 }), 0, "floored at 0, never negative");
});

// ── acceptance 1: min(N, headroom) tasks dispatch, concurrently ─────────────

test("W1-T172 acceptance 1: with WIP headroom and disjoint candidates, BOTH lanes are STARTED before either resolves — true concurrency, not a sequential loop", async () => {
  const plan = fixturePlan();
  const merged = new Set<string>();
  const started: string[] = [];
  const deferreds = new Map<string, { resolve: (r: RunResult) => void }>();
  const runOne = (id: string) =>
    new Promise<RunResult>((resolve) => {
      started.push(id);
      deferreds.set(id, { resolve });
    });

  const drainPromise = runDrain(plan, { refreshMerged: () => (id) => merged.has(id), runOne }, { laneCount: 2, max: 2 });

  // Let the pass's synchronous dispatch-set construction (the `.map` that
  // calls `runOne` for every lane) run before either lane's promise settles.
  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(started.sort(), ["A", "B"], "min(N=2, unbounded headroom) = 2 candidates, BOTH started before either resolved");

  deferreds.get("A")!.resolve(okResult("A"));
  deferreds.get("B")!.resolve(okResult("B"));
  const s = await drainPromise;
  assert.deepEqual(s.merged.sort(), ["A", "B"]);
});

test("W1-T172 acceptance 1 (the falsifier): headroom BELOW laneCount caps the pass below N — lanes raise the fill RATE, never the bound", async () => {
  const plan = fixturePlan();
  const merged = new Set<string>();
  const ran: string[] = [];
  const s = await runDrain(
    plan,
    {
      refreshMerged: () => (id) => merged.has(id),
      openPrCount: () => 2,
      runOne: async (id) => {
        ran.push(id);
        merged.add(id);
        return okResult(id);
      },
    },
    { laneCount: 2, wipLimit: 3, max: 1 },
  );
  assert.deepEqual(ran, ["A"], "headroom = wipLimit(3) - openPrCount(2) = 1, so only 1 of the requested 2 lanes dispatched");
  assert.equal(s.stopReason, "max_reached");
});

test("W1-T172: zero lane headroom this tick ⇒ stopReason wip_deferred with ZERO dispatches — distinct from no_runnable (work exists, held back)", async () => {
  const plan = fixturePlan();
  const merged = new Set<string>();
  const ran: string[] = [];
  const lines: Array<{ step: string; extra: Record<string, unknown> }> = [];
  const s = await runDrain(
    plan,
    {
      refreshMerged: () => (id) => merged.has(id),
      openPrCount: () => 5,
      runOne: async (id) => {
        ran.push(id);
        merged.add(id);
        return okResult(id);
      },
      log: (step, extra = {}) => lines.push({ step, extra }),
    },
    { laneCount: 2, wipLimit: 5, max: 3 },
  );
  assert.deepEqual(ran, []);
  assert.equal(s.stopReason, "wip_deferred");
  const line = lines.find((l) => l.step === "dispatch.wip_deferred");
  assert.ok(line, "dispatch.wip_deferred was ledgered");
  assert.equal(line?.extra.lane_count, 2);
  assert.equal(line?.extra.wip_limit, 5);
  assert.equal(line?.extra.observed_open_count, 5);
});

// ── acceptance 2: per-task guards (W1-T80 dedup, W1-T149 breaker) hold under concurrency ──

test("W1-T172 acceptance 2: an OPEN-PR task and a circuit-broken task are excluded from EVERY lane — concurrency never double-dispatches and never spins a task", async () => {
  const plan = fixturePlan(); // A(a.ts) B(b.ts) C(c.ts) D(a.ts, overlaps A)
  const merged = new Set<string>();
  const ran: string[] = [];
  const lines: Array<{ step: string; extra: Record<string, unknown> }> = [];
  const s = await runDrain(
    plan,
    {
      refreshMerged: () => (id) => merged.has(id),
      isOpenPr: (id) => (id === "B" ? 200 : undefined),
      isCircuitTripped: (id) => id === "C",
      runOne: async (id) => {
        ran.push(id);
        merged.add(id);
        return okResult(id);
      },
      log: (step, extra = {}) => lines.push({ step, extra }),
    },
    { laneCount: 3, max: 4 },
  );
  assert.ok(!ran.includes("B"), "B (open PR, W1-T80) was never dispatched by any lane, on any pass");
  assert.ok(!ran.includes("C"), "C (circuit-broken, W1-T149) was never dispatched by any lane, on any pass");
  assert.deepEqual(ran.sort(), ["A", "D"]);
  assert.equal(s.stopReason, "no_runnable");
  assert.ok(lines.some((l) => l.step === "dispatch.skipped" && l.extra.task === "B"));
  assert.ok(lines.some((l) => l.step === "dispatch.circuit_broken" && l.extra.task === "C"));
});

// ── acceptance 3: lane-local block semantics ─────────────────────────────────

test("W1-T172 acceptance 3: a block in one lane does not halt its siblings — the sibling runs to completion in the SAME pass while the blocked task takes its normal blocked path", async () => {
  const plan = fixturePlan();
  const merged = new Set<string>();
  const deferreds = new Map<string, { resolve: (r: RunResult) => void }>();
  const runOne = (id: string) => new Promise<RunResult>((resolve) => deferreds.set(id, { resolve }));

  const drainPromise = runDrain(plan, { refreshMerged: () => (id) => merged.has(id), runOne }, { laneCount: 2, max: 2 });
  await Promise.resolve();
  await Promise.resolve();

  // B (the SIBLING) resolves FIRST, merged — it never waited on A.
  deferreds.get("B")!.resolve(okResult("B"));
  await Promise.resolve();
  // A (this pass's blocked lane) resolves LAST.
  deferreds.get("A")!.resolve(blockedResult("A"));

  const s = await drainPromise;
  assert.deepEqual(s.merged, ["B"], "B merged despite A blocking in the SAME pass — the block never cancelled or raced ahead of it");
  assert.equal(s.stopReason, "blocked");
  assert.match(s.stopDetail ?? "", /A → blocked_review/);
});

test("W1-T172: a lane that THROWS does not abort its sibling either — the sibling's result is recorded before the pass reports the error", async () => {
  const plan = fixturePlan();
  const merged = new Set<string>();
  const runOne = async (id: string): Promise<RunResult> => {
    if (id === "A") throw new Error("boom");
    merged.add(id);
    return okResult(id);
  };
  const s = await runDrain(plan, { refreshMerged: () => (id) => merged.has(id), runOne }, { laneCount: 2, max: 2 });
  assert.equal(s.stopReason, "error");
  assert.match(s.stopDetail ?? "", /A: boom/);
  assert.deepEqual(s.merged, ["B"], "B's successful result survived A's throw in the same pass");
});

// ── acceptance 4: N=1 is byte-identical to the pre-lane serial drain ────────

test("W1-T172 acceptance 4: laneCount=1 and laneCount omitted reproduce the SAME dispatch sequence and the SAME ledger lines — the regression lock AND the off switch", async () => {
  const plan = fixturePlan();
  async function runWith(laneCount: number | undefined) {
    const merged = new Set<string>();
    const ran: string[] = [];
    const lines: string[] = [];
    const s = await runDrain(
      plan,
      {
        refreshMerged: () => (id) => merged.has(id),
        runOne: async (id) => {
          ran.push(id);
          if (id === "C") return blockedResult(id);
          merged.add(id);
          return okResult(id);
        },
        log: (step) => lines.push(step),
      },
      laneCount === undefined ? {} : { laneCount },
    );
    return { s, ran, lines };
  }

  const omitted = await runWith(undefined);
  const explicitOne = await runWith(1);

  assert.deepEqual(explicitOne.ran, omitted.ran);
  assert.deepEqual(explicitOne.lines, omitted.lines);
  assert.equal(omitted.s.stopReason, "blocked");
  assert.deepEqual(omitted.ran, ["A", "B", "C"], "D is never attempted — C's block halts the whole drain, unchanged doctrine");

  const laneOnlySteps = ["dispatch.concurrent_set", "dispatch.serialized", "dispatch.wip_deferred", "drain.lane_error"];
  for (const step of omitted.lines) {
    assert.ok(!laneOnlySteps.includes(step), `lane-only ledger step '${step}' must never appear on the N<=1 path`);
  }
});

// ── acceptance 5: dispatch.concurrent_set names the co-dispatched ids ───────

test("W1-T172 acceptance 5: each pass ledgers dispatch.concurrent_set naming the co-dispatched task ids — the evidence trail for P19's banked rung 2", async () => {
  const plan = fixturePlan();
  const merged = new Set<string>();
  const lines: Array<{ step: string; extra: Record<string, unknown> }> = [];
  await runDrain(
    plan,
    {
      refreshMerged: () => (id) => merged.has(id),
      runOne: async (id) => {
        merged.add(id);
        return okResult(id);
      },
      log: (step, extra = {}) => lines.push({ step, extra }),
    },
    { laneCount: 2, max: 2 },
  );
  const line = lines.find((l) => l.step === "dispatch.concurrent_set");
  assert.ok(line, "dispatch.concurrent_set was ledgered");
  assert.deepEqual(line?.extra.tasks, ["A", "B"]);
  assert.equal(line?.extra.lane_count, 2);
});

// ── W1-T171 integration: overlap within a co-dispatched set defers, self-resolves next pass ──

test("W1-T172 + W1-T171: an overlapping candidate within the SAME pass is deferred (dispatch.serialized), then dispatches on the NEXT pass once the collision clears", async () => {
  const plan = fixturePlan(); // A(a.ts) ... D(a.ts, overlaps A)
  const merged = new Set<string>();
  const ran: string[] = [];
  const lines: Array<{ step: string; extra: Record<string, unknown> }> = [];
  const s = await runDrain(
    plan,
    {
      refreshMerged: () => (id) => merged.has(id),
      // Exclude B/C so the pass's candidate set is exactly [A, D] — isolating
      // the overlap partition from the guard behaviour acceptance 2 already covers.
      isOpenPr: (id) => (id === "B" || id === "C" ? 1 : undefined),
      runOne: async (id) => {
        ran.push(id);
        merged.add(id);
        return okResult(id);
      },
      log: (step, extra = {}) => lines.push({ step, extra }),
    },
    { laneCount: 2, max: 4 },
  );
  const serializedLine = lines.find((l) => l.step === "dispatch.serialized");
  assert.ok(serializedLine, "the overlapping candidate was ledgered as serialized");
  assert.equal(serializedLine?.extra.task, "D");
  assert.equal(serializedLine?.extra.blocked_by, "A");
  assert.deepEqual(ran, ["A", "D"], "D dispatches on the pass AFTER A — self-resolving, no second bookkeeping needed");
  assert.equal(s.stopReason, "no_runnable");
});
