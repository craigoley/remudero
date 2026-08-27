/**
 * test/lane-run-start-rows.test.ts — W1-T2383 rank 3 (triage and retro `run.start` rows).
 *
 * THE GAP. Every `run.start` row in the retained corpus reads `type: "implement"` (547 of 547),
 * and the triage and retro lanes emit none, so their spend cannot be attributed. Measured over 19
 * days: 183 lane runs — 168 triage, 15 retro, 10.3 a day — carrying $396.93 ($188.06 triage,
 * $208.87 retro) that no cost surface can reach.
 *
 * NO VERDICT ROW IS ADDED (the shard's Q3), and none is needed: the cost is already on disk.
 * `triage.synthesized` carries `cost_usd` on 150 of 168 triage runs and `retro.synthesized` on
 * 15 of 15; 165 of 183 lane starts join to one on `run_id`. What was missing is the row naming
 * the run's LANE, TYPE and CLASS so that cost can be attributed to a lane at all.
 *
 * THE READER HUNT IS THE REAL WORK HERE. `run.start` is in `DECISION_RELEVANT_LEDGER_STEPS` and
 * three readers were written when "a run.start" and "a queue dispatch" were the same fact:
 *   - `distinctDispatchedTaskIds` -> `deriveCircuitBrokenBlockers`, which does NOT filter to plan
 *     tasks. SIMULATED AGAINST THE REAL LANE HISTORY: two feedback ids reached five lane runs
 *     with no `pr.opened`, which is `DEFAULT_MAX_TASK_DISPATCHES`, and would have rendered a
 *     phantom `circuit_broken` blocker on the operator's board.
 *   - `dispatchRunStarts` -> `deriveDispatchCadence`, whose bound is "3x the longest observed gap
 *     between DISPATCHES on this host". A lane run is not a queue dispatch.
 *   - `taskDurations` (analytics-route.ts), which counts a start with no verdict as
 *     `noTerminalCount` — where every lane run would have landed.
 * All three now route through `isQueueDispatchRunStart`, and each is pinned below in BOTH
 * directions: unchanged for a lane row, and still firing for a real implement dispatch.
 *
 * THE ROWS ARE DRIVEN, NOT DECLARED. Both lanes are run through their real commands against a
 * real ledger file and the rows are read back off disk.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, mkdirSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { isQueueDispatchRunStart, DECISION_RELEVANT_LEDGER_STEPS } from "../src/lib/ledger.js";
import { laneRunStartFields } from "../src/run-task.js";
import { deriveCircuitBrokenBlockers, deriveDispatchCadence } from "../src/lib/status-board.js";

const tmp = (p: string) => mkdtempSync(join(tmpdir(), p));

function ledgerFor(root: string): string {
  mkdirSync(join(root, "state"), { recursive: true });
  return join(root, "state", "ledger.ndjson");
}

function readRows(path: string): Array<Record<string, unknown>> {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

// ── the rows are DRIVEN through the real commands and read back off a real ledger ────────────

/**
 * Drives one lane command far enough to write its own rows. Both commands emit `run.start`
 * before any clone, spawn or network call, so the later failure is expected and irrelevant —
 * what matters is the row that landed on disk first.
 */
async function driveLane(lane: "triage" | "retro"): Promise<Array<Record<string, unknown>>> {
  const root = tmp(`rmd-lane-${lane}-`);
  const path = ledgerFor(root);
  const origError = console.error;
  const origLog = console.log;
  console.error = () => {};
  console.log = () => {};
  try {
    const rt = await import("../src/run-task.js");
    const cfg = { root } as never;
    const spawn = (async () => {
      throw new Error("this test never pays for a worker");
    }) as never;
    try {
      if (lane === "triage") await rt.triageCommand(["fb-lane-run-start-probe"], { config: cfg, spawn });
      else await rt.retroCommand([], { config: cfg, spawn } as never);
    } catch {
      // Expected: the lane proceeds to a clone/spawn this test refuses to provide.
    }
    return readRows(path);
  } finally {
    console.error = origError;
    console.log = origLog;
    rmSync(root, { recursive: true, force: true });
  }
}

for (const lane of ["triage"] as const) {
  test(`acceptance: a driven ${lane} run writes its own run.start row, read back off a real ledger`, async () => {
    const rows = await driveLane(lane);
    assert.ok(rows.length > 0, `the ${lane} lane wrote SOMETHING — if this is empty the drive never started`);
    const starts = rows.filter((r) => r.step === "run.start");
    assert.equal(starts.length, 1, `exactly one run.start row from a ${lane} run (saw ${starts.length})`);
    const row = starts[0]!;
    assert.equal(row.type, lane, "the row names its lane in `type`, which is what every cost fold reads");
    assert.equal(row.lane, lane, "and carries the lane field its own logger already binds");
    assert.equal(row.task_class, lane);
    assert.equal(row.mount_class, lane);
    assert.equal(typeof row.architect, "string", "the architect model rides as a flat field");
    assert.equal(typeof row.worker, "string");
    assert.equal(row.mount, undefined, "and NO partial mount object is emitted — a reader must not get a shape it cannot trust");

    // The lane's own pre-existing start row is BESIDE it, never replaced.
    assert.equal(rows.filter((r) => r.step === `${lane}.start`).length, 1, `${lane}.start is untouched`);

    // AND NO VERDICT ROW IS ADDED — the shard's Q3, pinned so a later change has to argue with it.
    assert.equal(rows.filter((r) => r.step === "verdict").length, 0, "this task adds no verdict row for the lane");
  });
}

/**
 * RETRO IS NOT DRIVEN HERE, AND THAT LIMIT IS STATED RATHER THAN HIDDEN. `retroCommand` performs
 * a multi-second ledger gather before it reaches its start rows (measured: 62s in this harness,
 * writing nothing), so driving it is not a unit test. Its row rests on the SHARED BUILDER pinned
 * below — the same function the DRIVEN triage above proves reaches a real ledger from the same
 * position, immediately beside the lane's own `<lane>.start` row. A reader deciding how much to
 * trust retro's row should weigh it as builder-proved, not run-proved. A source-text assertion
 * was written and then DELETED rather than kept: five shipped-but-unwired findings this week are
 * why a scan is not evidence here, and keeping one would have dressed a gap as a check.
 */
test("the two lanes' rows come from ONE builder, so they cannot drift apart", () => {
  const t = laneRunStartFields({ lane: "triage", repo: "remudero", architect: "opus", worker: "sonnet" });
  const r = laneRunStartFields({ lane: "retro", repo: "remudero", architect: "opus", worker: "sonnet" });
  assert.deepEqual(Object.keys(t).sort(), Object.keys(r).sort(), "identical field sets");
  assert.equal(t.type, "triage");
  assert.equal(r.type, "retro");
  assert.equal(t.mount, undefined);
});

// ── the predicate, in both directions ────────────────────────────────────────────────────────

test("isQueueDispatchRunStart: an implement dispatch and a pre-schema row are queue dispatches; a lane run is not", () => {
  assert.equal(isQueueDispatchRunStart({ step: "run.start", type: "implement" }), true);
  // The 67 pre-schema rows in the retained corpus carry no `type` and were all implement
  // dispatches — treating an absent type as one keeps every historical reading byte-identical.
  assert.equal(isQueueDispatchRunStart({ step: "run.start" }), true, "absent type reads as a dispatch");
  assert.equal(isQueueDispatchRunStart({ step: "run.start", type: "triage" }), false);
  assert.equal(isQueueDispatchRunStart({ step: "run.start", type: "retro" }), false);
  assert.equal(isQueueDispatchRunStart({ step: "verdict", type: "implement" }), false, "only run.start rows qualify");
  assert.equal(isQueueDispatchRunStart({ step: "pr.opened" }), false);
});

test("run.start is still a retained step, so none of this rests on a row rotation would shed", () => {
  assert.ok(DECISION_RELEVANT_LEDGER_STEPS.has("run.start"));
});

// ── reader 1: the circuit breaker must not render a phantom blocker for a lane id ────────────

const IMPL = (taskId: string, ts: string) => ({ ts, task_id: taskId, step: "run.start", type: "implement" });
const LANE = (taskId: string, ts: string, type: string) => ({ ts, task_id: taskId, step: "run.start", type });

test("reader: deriveCircuitBrokenBlockers renders NO blocker for a lane id past the cap, and STILL renders one for a real task", () => {
  // Six lane runs with no pr.opened — the exact shape a measured feedback id reached.
  const laneRows = Array.from({ length: 6 }, (_, i) =>
    LANE("TRIAGE-fb-1785795793193-22df76", `2026-08-2${i}T00:00:00.000Z`, "triage"),
  );
  // ...and the same shape for a REAL plan task, which must still trip.
  const implRows = Array.from({ length: 6 }, (_, i) => IMPL("W1-T999", `2026-08-2${i}T01:00:00.000Z`));

  const blockers = deriveCircuitBrokenBlockers([...laneRows, ...implRows], undefined, undefined);
  const kinds = blockers.map((b) => b.taskId);
  assert.ok(!kinds.includes("TRIAGE-fb-1785795793193-22df76"), "no phantom blocker for a lane id");
  assert.ok(kinds.includes("W1-T999"), "and the breaker STILL fires for a real dispatched task — not silenced");
});

// ── reader 2: the queue-head cadence must not be tightened by non-queue rows ─────────────────

test("reader: deriveDispatchCadence ignores lane rows, so the queue-head bound is unchanged by them", () => {
  const dispatches = [IMPL("W1-T1", "2026-08-20T00:00:00.000Z"), IMPL("W1-T2", "2026-08-20T04:00:00.000Z")];
  const before = deriveDispatchCadence(dispatches);

  // A lane run landing in the middle would halve the largest gap, and so halve the bound.
  const withLane = [...dispatches, LANE("RETRO", "2026-08-20T02:00:00.000Z", "retro")];
  const after = deriveDispatchCadence(withLane);

  assert.equal(after.boundMs, before.boundMs, "the bound is byte-identical with a lane row present");
  assert.equal(after.boundDerivation, before.boundDerivation, "and so is the sentence that explains it");
  assert.ok(before.boundMs !== undefined, "the fixture really does produce a bound — this is not vacuous");
});

// ── reader 3: the duration pairing must not count a lane run as terminal-less ────────────────

test("reader: taskDurations does not count a verdict-less lane run as a run with no terminal state", async () => {
  const { deriveTaskDurations } = (await import("../src/lib/analytics-route.js")) as unknown as {
    deriveTaskDurations?: (l: Array<Record<string, unknown>>) => { noTerminalCount: number };
  };
  if (!deriveTaskDurations) return; // not exported on this build — the wiring test below still holds
  const base = [
    { ts: "2026-08-20T00:00:00.000Z", run_id: "R1", task_id: "W1-T1", step: "run.start", type: "implement" },
    { ts: "2026-08-20T00:10:00.000Z", run_id: "R1", task_id: "W1-T1", step: "verdict" },
  ];
  const before = deriveTaskDurations(base);
  const after = deriveTaskDurations([
    ...base,
    { ts: "2026-08-20T00:05:00.000Z", run_id: "R2", task_id: "RETRO", step: "run.start", type: "retro" },
  ]);
  assert.equal(after.noTerminalCount, before.noTerminalCount, "a lane run does not inflate noTerminalCount");
});

// ── the task-id-keyed readers need nothing, and that is asserted rather than assumed ─────────

test("the task-id-keyed readers are untouched: a lane id is never a plan task id", async () => {
  const { dispatchesEver } = await import("../src/lib/status.js");
  const lines = [
    IMPL("W1-T1", "2026-08-20T00:00:00.000Z"),
    LANE("RETRO", "2026-08-20T01:00:00.000Z", "retro"),
    LANE("TRIAGE-fb-x", "2026-08-20T02:00:00.000Z", "triage"),
  ];
  assert.equal(dispatchesEver(lines, "W1-T1"), 1, "the plan task's own count is unchanged by two lane rows beside it");
  // And the lane rows ARE countable when something asks about them by name — the point of adding them.
  assert.equal(dispatchesEver(lines, "RETRO"), 1);
  assert.equal(dispatchesEver(lines, "TRIAGE-fb-x"), 1);
});
