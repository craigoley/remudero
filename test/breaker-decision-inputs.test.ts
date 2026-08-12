import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createDispatchBreakerCache,
  evaluateDispatchBreakerCorroboratedDetailed,
  evaluateDispatchBreakerDetailed,
} from "../src/lib/status.js";
import { nextRunnable, runDrain } from "../src/lib/drain.js";
import { runDaemon } from "../src/lib/daemon.js";
import { breakerDetailDep, breakerGateFor } from "../src/run-task.js";
import { loadPlan, type Plan, type Task } from "../src/lib/plan.js";

/**
 * W1-T314: `dispatch.circuit_broken` carried `{task}` and NOTHING else — no count, no
 * threshold, no outcome. The measured consequence: one daemon process logged
 * `dispatch.circuit_broken {task: W1-T314}` at 2026-08-04T15:02:25 and `run.start` for the SAME
 * task at 15:11:51, with no `pr.opened`, no kick and no rotation between, and WHY IT RE-ENTERED
 * IS UNRECOVERABLE FROM THE RECORD. That task's runs cost $130.49.
 *
 * These tests pin the three things that make the row trustworthy: every outcome is
 * DISTINGUISHABLE, the values are the ones the decision CONSUMED (not a recomputation that could
 * answer differently), and the clear path stays silent.
 */

function ledgerWith(lines: Array<Record<string, unknown>>): string {
  const dir = mkdtempSync(join(tmpdir(), "rmd-breaker-inputs-"));
  const path = join(dir, "ledger.ndjson");
  writeFileSync(path, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  return path;
}

/** A two-task plan in the exact shape test/drain.test.ts's own fixture uses. */
function drainFixturePlan(): Plan {
  const dir = mkdtempSync(join(tmpdir(), "brk-drain-"));
  const f = join(dir, "tasks.yaml");
  writeFileSync(
    f,
    [
      "- id: A",
      "  title: a",
      "  repo: remudero",
      "  type: implement",
      "  depends_on: []",
      "  status: queued",
      "- id: D",
      "  title: d",
      "  repo: remudero",
      "  type: implement",
      "  depends_on: []",
      "  status: queued",
      "",
    ].join("\n"),
  );
  return loadPlan(f);
}

const runStarts = (taskId: string, n: number) =>
  Array.from({ length: n }, () => ({ step: "run.start", task_id: taskId }));

// ── Direction 1 of 3: TRIPPED ────────────────────────────────────────────────

test("detail: a TRIPPED outcome records the count, the bound it was compared against, and the outcome", () => {
  const path = ledgerWith(runStarts("W1-T1", 5));
  const d = evaluateDispatchBreakerDetailed(path, "W1-T1", createDispatchBreakerCache());

  assert.equal(d.state, "tripped");
  assert.equal(d.ledgerState, "tripped");
  assert.equal(d.freshCount, 5, "the count the comparison actually used");
  assert.equal(d.maxDispatches, 5, "the bound it was compared against");
  assert.equal(d.hasNewOwnedPr, false);
  assert.equal(d.priorCount, undefined, "first observation has no prior");
  assert.equal(d.corroboration, undefined, "corroboration was never consulted on this entry point");
});

// ── Direction 2 of 3: CLEAR ──────────────────────────────────────────────────

test("detail: a CLEAR outcome is distinguishable from tripped — same fields, different values", () => {
  const path = ledgerWith(runStarts("W1-T1", 2));
  const d = evaluateDispatchBreakerDetailed(path, "W1-T1", createDispatchBreakerCache());

  assert.equal(d.state, "clear");
  assert.equal(d.ledgerState, "clear");
  assert.equal(d.freshCount, 2);
  assert.equal(d.maxDispatches, 5);
});

// ── Direction 3 of 3: INDETERMINATE — the one that must never read as "tripped" ──

test("detail: an INDETERMINATE outcome says so, and is NOT reported as tripped", () => {
  const cache = createDispatchBreakerCache();
  const full = ledgerWith(runStarts("W1-T1", 6));
  const first = evaluateDispatchBreakerDetailed(full, "W1-T1", cache);
  assert.equal(first.state, "tripped");
  assert.equal(first.freshCount, 6);

  // The ledger regresses with nothing in it to explain the drop (rotation/truncation).
  const shrunk = ledgerWith(runStarts("W1-T1", 1));
  const d = evaluateDispatchBreakerDetailed(shrunk, "W1-T1", cache);

  assert.equal(d.state, "indeterminate", "a regressed count is missing information, not a verdict");
  assert.equal(d.ledgerState, "indeterminate");
  assert.notEqual(d.state, "tripped", "conflating unresolvable with tripped is the six-times defect");
  assert.equal(d.freshCount, 1, "the count that was actually read");
  assert.equal(d.priorCount, 6, "the prior it regressed FROM — the whole reason this is indeterminate");
  assert.equal(d.hasNewOwnedPr, false, "the second term of the regression test");
});

test("detail: the three outcomes are mutually distinguishable — a change labelling everything tripped fails", () => {
  const cache = createDispatchBreakerCache();
  const tripped = evaluateDispatchBreakerDetailed(ledgerWith(runStarts("A", 5)), "A", createDispatchBreakerCache());
  const clear = evaluateDispatchBreakerDetailed(ledgerWith(runStarts("B", 1)), "B", createDispatchBreakerCache());
  evaluateDispatchBreakerDetailed(ledgerWith(runStarts("C", 6)), "C", cache);
  const indet = evaluateDispatchBreakerDetailed(ledgerWith(runStarts("C", 0)), "C", cache);

  const states = [tripped.state, clear.state, indet.state];
  assert.deepEqual(states, ["tripped", "clear", "indeterminate"]);
  assert.equal(new Set(states).size, 3, "all three outcomes must be distinct values on the row");
});

// ── Corroboration: absent and "unreadable" are different facts ───────────────

test("detail: corroboration is ABSENT when not consulted and NAMED when it is — never collapsed", () => {
  const path = ledgerWith(runStarts("W1-T1", 5));

  const uncorroborated = evaluateDispatchBreakerDetailed(path, "W1-T1", createDispatchBreakerCache());
  assert.equal(uncorroborated.corroboration, undefined, "never consulted ⇒ absent, not a value");

  const unreadable = evaluateDispatchBreakerCorroboratedDetailed(
    path,
    "W1-T1",
    createDispatchBreakerCache(),
    null, // the read FAILED — distinct from "read fine, found nothing"
  );
  assert.equal(unreadable.corroboration, "unreadable");
  assert.equal(unreadable.ledgerState, "tripped");
  assert.equal(unreadable.state, "tripped", "an unreadable corroboration never withdraws a trip");

  const corroborated = evaluateDispatchBreakerCorroboratedDetailed(path, "W1-T1", createDispatchBreakerCache(), [
    { number: 1, headRefName: "run-W1-T1-1785000000000" } as never,
  ]);
  assert.equal(corroborated.corroboration, "corroborated");
  assert.equal(corroborated.ledgerState, "tripped", "the LEDGER still said tripped");
  assert.equal(corroborated.state, "clear", "and corroboration is what cleared it — two separate facts");
});

// ── THE TRAP: the row must carry the CONSUMED values, not a recomputation ────

test("the logged detail is the value the DECISION consumed — a ledger that moves underneath does not rewrite it", () => {
  const path = ledgerWith(runStarts("W1-T1", 5));
  // The REAL production gate, not a replica of its shape.
  const gate = breakerGateFor(path, undefined);

  assert.equal(gate.isTripped("W1-T1"), true);
  const consumed = { ...gate.detailFor("W1-T1") };
  assert.equal(consumed.freshCount, 5);
  assert.equal(consumed.state, "tripped");

  // The ledger moves under a live daemon. A SECOND evaluation would now answer differently, and
  // a row built from it would be a plausible lie about a decision made on other numbers.
  writeFileSync(path, JSON.stringify({ step: "pr.opened", task_id: "W1-T1" }) + "\n");
  const recomputed = evaluateDispatchBreakerCorroboratedDetailed(
    path,
    "W1-T1",
    createDispatchBreakerCache(),
    undefined,
  );
  assert.notEqual(recomputed.freshCount, consumed.freshCount, "the fixture must actually diverge, or this proves nothing");

  assert.deepEqual(gate.detailFor("W1-T1"), consumed, "the row still reports what the decision was made on");
  assert.equal(gate.isTripped("W1-T1"), true, "and the predicate has not silently changed its mind either");
});

test("breakerGateFor: the boolean predicates and the row read ONE evaluation — they cannot disagree", () => {
  const path = ledgerWith(runStarts("W1-T1", 5));
  const gate = breakerGateFor(path, undefined);
  const detail = gate.detailFor("W1-T1");
  assert.equal(gate.isTripped("W1-T1"), detail.state === "tripped");
  assert.equal(gate.isIndeterminate("W1-T1"), detail.state === "indeterminate");

  // A different task re-evaluates (single-entry memo), and the first task's row still reports
  // its own numbers rather than the neighbour's.
  const other = ledgerWith(runStarts("W1-T2", 1));
  const gate2 = breakerGateFor(other, undefined);
  assert.equal(gate2.detailFor("W1-T2").freshCount, 1);
  assert.equal(gate2.isTripped("W1-T2"), false);
});

// ── THIRD TRAP: the clear path must not spam the ledger ──────────────────────

test("a CLEAR outcome writes no breaker row — the gate runs per candidate per pass", () => {
  const rows: Array<{ step: string; task: string }> = [];
  const task = (id: string): Task =>
    ({ id, title: id, type: "implement", verify: "auto", status: "queued", depends_on: [] }) as unknown as Task;
  // Many candidates, all CLEAR: an unconditional row would be one per task per pass.
  const plan = { tasks: ["A", "B", "C", "D", "E"].map(task) } as unknown as Plan;

  nextRunnable(plan, () => false, {
    isCircuitTripped: () => false,
    isIndeterminate: () => false,
    onCircuitBreak: (t: Task) => rows.push({ step: "dispatch.circuit_broken", task: t.id }),
    onIndeterminate: (t: Task) => rows.push({ step: "dispatch.indeterminate", task: t.id }),
  } as never);

  assert.deepEqual(rows, [], "no breaker row on the clear path, however many candidates are scanned");
});

test("a TRIPPED candidate still writes exactly one row — the silence above is not silence everywhere", () => {
  const rows: Array<{ step: string; task: string }> = [];
  const task = (id: string): Task =>
    ({ id, title: id, type: "implement", verify: "auto", status: "queued", depends_on: [] }) as unknown as Task;
  const plan = { tasks: [task("A")] } as unknown as Plan;

  nextRunnable(plan, () => false, {
    isCircuitTripped: (id: string) => id === "A",
    onCircuitBreak: (t: Task) => rows.push({ step: "dispatch.circuit_broken", task: t.id }),
  } as never);

  assert.deepEqual(rows, [{ step: "dispatch.circuit_broken", task: "A" }]);
});

// ── The row itself: runDrain / runDaemon must EMIT the detail, not just hold it ──
//
// The tests above prove the detail is correct and consumed-not-recomputed. These drive the REAL
// `runDrain` and assert what lands on the ledger row, so a revert that de-enriches the log call
// fails here rather than only in a source-text assertion.

const DETAIL_FIXTURE = {
  state: "tripped",
  ledgerState: "tripped",
  freshCount: 5,
  maxDispatches: 5,
  hasNewOwnedPr: false,
  corroboration: "not-corroborated",
} as const;

test("runDrain: the dispatch.circuit_broken row carries the count, the bound and the outcome", async () => {
  const plan = drainFixturePlan();
  const merged = new Set<string>();
  const lines: Array<{ step: string; extra: Record<string, unknown> }> = [];
  await runDrain(
    plan,
    {
      refreshMerged: () => (id: string) => merged.has(id),
      isCircuitTripped: (id: string) => id === "A",
      breakerDetail: (id: string) => (id === "A" ? { ...DETAIL_FIXTURE } : undefined),
      runOne: async (id: string) => {
        merged.add(id);
        return { taskId: id, runId: id + "-run", merged: true, costUsd: 0.5, verdict: "merged" } as never;
      },
      log: (step: string, extra: Record<string, unknown> = {}) => lines.push({ step, extra }),
    } as never,
    { max: 1 },
  );

  const row = lines.find((l) => l.step === "dispatch.circuit_broken");
  assert.ok(row, "a dispatch.circuit_broken row was emitted");
  assert.equal(row?.extra.task, "A");
  assert.equal(row?.extra.freshCount, 5, "the count the gate compared");
  assert.equal(row?.extra.maxDispatches, 5, "the bound it compared against");
  assert.equal(row?.extra.state, "tripped", "WHICH outcome was reached");
  assert.equal(row?.extra.corroboration, "not-corroborated");
});

test("runDrain: the dispatch.indeterminate row says INDETERMINATE, never tripped", async () => {
  const plan = drainFixturePlan();
  const merged = new Set<string>();
  const lines: Array<{ step: string; extra: Record<string, unknown> }> = [];
  await runDrain(
    plan,
    {
      refreshMerged: () => (id: string) => merged.has(id),
      isIndeterminate: (id: string) => id === "A",
      breakerDetail: (id: string) =>
        id === "A" ? { state: "indeterminate", ledgerState: "indeterminate", freshCount: 1, maxDispatches: 5, priorCount: 6, hasNewOwnedPr: false } : undefined,
      runOne: async (id: string) => {
        merged.add(id);
        return { taskId: id, runId: id + "-run", merged: true, costUsd: 0.5, verdict: "merged" } as never;
      },
      log: (step: string, extra: Record<string, unknown> = {}) => lines.push({ step, extra }),
    } as never,
    { max: 1 },
  );

  const row = lines.find((l) => l.step === "dispatch.indeterminate");
  assert.ok(row, "a dispatch.indeterminate row was emitted");
  assert.equal(row?.extra.state, "indeterminate");
  assert.notEqual(row?.extra.state, "tripped", "an unresolvable read must never be recorded as a verdict");
  assert.equal(row?.extra.priorCount, 6, "the prior it regressed FROM — why it is indeterminate");
  assert.equal(row?.extra.freshCount, 1);
});

test("runDrain: a caller that omits breakerDetail still logs the bare row — the dep is optional", async () => {
  const plan = drainFixturePlan();
  const merged = new Set<string>();
  const lines: Array<{ step: string; extra: Record<string, unknown> }> = [];
  await runDrain(
    plan,
    {
      refreshMerged: () => (id: string) => merged.has(id),
      isCircuitTripped: (id: string) => id === "A",
      runOne: async (id: string) => {
        merged.add(id);
        return { taskId: id, runId: id + "-run", merged: true, costUsd: 0.5, verdict: "merged" } as never;
      },
      log: (step: string, extra: Record<string, unknown> = {}) => lines.push({ step, extra }),
    } as never,
    { max: 1 },
  );
  const row = lines.find((l) => l.step === "dispatch.circuit_broken");
  assert.deepEqual(row?.extra, { task: "A" }, "omitting the dep degrades to exactly the pre-change row");
});

// The multi-lane pass loop (`runDrainLanes`) builds its own hooks separately from the single-lane
// loop above — a fix applied to only one of the two would leave the other logging bare rows.
test("runDrainLanes: the lanes path enriches BOTH breaker rows too, not just the single-lane loop", async () => {
  for (const [flag, step, detail] of [
    ["isCircuitTripped", "dispatch.circuit_broken", { ...DETAIL_FIXTURE }],
    [
      "isIndeterminate",
      "dispatch.indeterminate",
      { state: "indeterminate", ledgerState: "indeterminate", freshCount: 2, maxDispatches: 5, priorCount: 9, hasNewOwnedPr: false },
    ],
  ] as const) {
    const merged = new Set<string>();
    const lines: Array<{ step: string; extra: Record<string, unknown> }> = [];
    await runDrain(
      drainFixturePlan(),
      {
        refreshMerged: () => (id: string) => merged.has(id),
        [flag]: (id: string) => id === "A",
        breakerDetail: (id: string) => (id === "A" ? detail : undefined),
        runOne: async (id: string) => {
          merged.add(id);
          return { taskId: id, runId: id + "-run", merged: true, costUsd: 0.5, verdict: "merged" } as never;
        },
        log: (s: string, extra: Record<string, unknown> = {}) => lines.push({ step: s, extra }),
      } as never,
      { laneCount: 2, max: 2 },
    );
    const row = lines.find((l) => l.step === step);
    assert.ok(row, `${step} row emitted on the lanes path`);
    assert.equal(row?.extra.state, detail.state, `${step}: the lanes path carries the outcome`);
    assert.equal(row?.extra.freshCount, detail.freshCount, `${step}: and the count the gate used`);
  }
});

test("breakerDetailDep: the dep both dispatch commands wire snapshots the memoised detail", () => {
  const path = ledgerWith(runStarts("W1-T1", 5));
  const gate = breakerGateFor(path, undefined);
  const dep = breakerDetailDep(gate);

  const row = dep("W1-T1");
  assert.equal(row.state, "tripped");
  assert.equal(row.freshCount, 5);
  assert.equal(row.maxDispatches, 5);
  assert.notEqual(row, gate.detailFor("W1-T1"), "the row is a COPY — mutating it cannot corrupt the gate");
  assert.deepEqual(row, { ...gate.detailFor("W1-T1") }, "but it carries exactly the consumed values");
});

// The daemon builds its own hooks separately from both drain loops — a third place the fix has
// to reach, and the one whose bare row produced the unrecoverable 2026-08-04 record.
test("runDaemon: the dispatch.indeterminate row carries the outcome and the regressed prior", async () => {
  const merged = new Set<string>();
  const lines: Array<{ step: string; extra: Record<string, unknown> }> = [];
  await runDaemon(
    drainFixturePlan(),
    {
      refreshMerged: () => (id: string) => merged.has(id),
      isIndeterminate: (id: string) => id === "A",
      breakerDetail: (id: string) =>
        id === "A"
          ? { state: "indeterminate", ledgerState: "indeterminate", freshCount: 0, maxDispatches: 5, priorCount: 5, hasNewOwnedPr: false }
          : undefined,
      runOne: async (id: string) => {
        merged.add(id);
        return { taskId: id, runId: id + "-run", merged: true, costUsd: 0.5, verdict: "merged" } as never;
      },
      log: (s: string, extra: Record<string, unknown> = {}) => lines.push({ step: s, extra }),
      sleep: async () => {},
    } as never,
    { max: 1 },
  );

  const row = lines.find((l) => l.step === "dispatch.indeterminate");
  assert.ok(row, "the daemon emitted a dispatch.indeterminate row");
  assert.equal(row?.extra.task, "A");
  assert.equal(row?.extra.state, "indeterminate", "the daemon's row names the outcome too");
  assert.notEqual(row?.extra.state, "tripped");
  assert.equal(row?.extra.priorCount, 5, "and the prior the count regressed from");
});
