// W1-T2415 (follow-on coverage) — THE WIRING, not the two functions.
//
// `test/queue-head-names-a-circuit-broken-refusal.test.ts` (#3170, merged) already pins
// `deriveQueueHead`'s refused row and `renderQueueHeadBlock`'s wording. THIS file asserts the
// same property one level up, through `buildStatusBoard` and `renderStatusBoardText`, because
// those two are wired together by a call site neither of the merged tests reaches.
//
// MEASURED, and the reason this file exists rather than being folded into that one: with
// `renderStatusBoardText` mutated to drop the breaker line while `deriveQueueHead` and
// `renderQueueHeadBlock` stay byte-identical, the merged suite passes 9 of 9 and this one fails
// 3 of 8. The merged suite cannot see a wiring break by construction — it never calls the
// assembler. No production line is added here; #3170 shipped the implementation and this adds
// only the end-to-end assertion its own altitude could not make.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadPlanFromYaml } from "../src/lib/plan.js";
import { IDLE_REASON_ID_CAP, runnableCandidates, tallyDispatchFilters, type MergedSet } from "../src/lib/drain.js";
import { buildStatusBoard, renderStatusBoardText, type StatusBoardDeps } from "../src/lib/status-board.js";
import { DEFAULT_MAX_TASK_DISPATCHES, isDispatchBreakerTripped, type GitHub } from "../src/lib/status.js";

// W1-T2415 — `deriveQueueHead` (status-board.ts) binds `isCircuitTripped` into
// `runnableCandidates`'s options, so a tripped task is correctly REMOVED from `rows` — but it
// passed neither `onCircuitBreak` nor `onIndeterminate`, so the callback that would NAME the
// exclusion was never supplied. The task leaves QUEUE HEAD's `rows` and lands in nothing: the
// sibling exclusion `run-branch-already-pushed` gets a `refused` row from the very same call,
// the circuit breaker did not. This file proves the task's eight acceptance claims, in order.

const NONE_MERGED: MergedSet = () => false;

const TWO_TASK_YAML = `
- id: W1-T910
  title: never dispatched, fully eligible
  repo: remudero
  type: implement
  verify: auto
  depends_on: []
  status: queued
- id: W1-T920
  title: dispatched past the breaker threshold with no new owned PR
  repo: remudero
  type: implement
  verify: auto
  depends_on: []
  status: queued
`;

function plan() {
  return loadPlanFromYaml(TWO_TASK_YAML, "fixture");
}

function tmpRoot(): string {
  return mkdtempSync(join(tmpdir(), "queue-head-circuit-broken-"));
}

function writeLedger(lines: Record<string, unknown>[]): string {
  const ledgerPath = join(mkdtempSync(join(tmpdir(), "queue-head-circuit-broken-ledger-")), "ledger.ndjson");
  writeFileSync(ledgerPath, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  return ledgerPath;
}

function fakeGithub(overrides: Partial<GitHub> = {}): GitHub {
  return {
    prByRef: () => null,
    findMergedByTrailer: () => null,
    headRefName: () => undefined,
    prBody: () => undefined,
    readFailed: () => false,
    ...overrides,
  };
}

const NOW_ISO = "2026-08-27T12:00:00.000Z";
const NOW_MS = Date.parse(NOW_ISO);

/** A never-running, never-fetching, offline-safe deps bundle — mirrors
 *  test/queue-head-dispatch-parity.test.ts's own `baseDeps` convention. */
function baseDeps(overrides: Partial<StatusBoardDeps> = {}): StatusBoardDeps {
  return {
    queryService: () => ({ running: false, pid: null }),
    repoDir: "/nonexistent/repo/for/tests",
    now: () => NOW_MS,
    resolveOriginMainSha: () => undefined,
    isPidAlive: () => true,
    plan: plan(),
    github: fakeGithub(),
    readPushedRunBranches: () => "",
    ...overrides,
  };
}

/** `dispatchesWithoutNewOwnedPr` (status.ts) counts `run.start` lines for `taskId` since its
 *  last forward-progress line — `DEFAULT_MAX_TASK_DISPATCHES` (5) of them with no `pr.opened`/
 *  merge credit in between trips `isDispatchBreakerTripped`, the SAME signal `isCircuitTripped`
 *  (status-board.ts) re-reads. */
function tripBreakerLines(taskId: string, count: number = DEFAULT_MAX_TASK_DISPATCHES): Record<string, unknown>[] {
  return Array.from({ length: count }, (_, i) => ({
    step: "run.start",
    task_id: taskId,
    ts: `2026-08-27T00:0${i}:00.000Z`,
    run_id: `run-${taskId}-${i}`,
  }));
}

// ── ACCEPTANCE 1: "a circuit-broken task is named on the queue head's refused list instead of
// vanishing from it" ────────────────────────────────────────────────────────────────────────────

test("buildStatusBoard: QUEUE HEAD — a task whose dispatch circuit breaker has tripped is EXCLUDED from `rows` AND named in `refused`, never vanishing from the surface with no trace", () => {
  const ledgerPath = writeLedger(tripBreakerLines("W1-T920"));
  // W1-T450's STALL rule (also driven off `rows.length > 0`) otherwise wins `nextAction` here
  // (the newest `run.start` this fixture writes is old relative to a `now` far in the future) —
  // pin `now` close to the newest observed dispatch so THIS test isolates the refusal message
  // this task adds, not an unrelated rule that already has its own coverage.
  const nowNearLedger = () => Date.parse("2026-08-27T00:05:00.000Z");
  const model = buildStatusBoard(tmpRoot(), ledgerPath, baseDeps({ now: nowNearLedger }));

  assert.deepEqual(model.queueHead.rows.map((r) => r.taskId), ["W1-T910"], "the tripped task never dispatches");
  assert.equal(model.queueHead.refused.length, 1, "the exclusion is NAMED, not silently dropped");
  assert.equal(model.queueHead.refused[0]!.taskId, "W1-T920");
  assert.equal(model.queueHead.refused[0]!.title, "dispatched past the breaker threshold with no new owned PR");
  assert.equal(model.queueHead.refused[0]!.reason, "circuit-broken");

  const text = renderStatusBoardText(model);
  assert.match(text, /REFUSED: W1-T920/, "the row renders on the text surface too");
  assert.match(model.queueHead.nextAction ?? "", /W1-T920/);
  assert.match(model.queueHead.nextAction ?? "", /circuit breaker/);
});

// ── ACCEPTANCE 2: "the named refusal carries the dispatch count and the breaker's own reset
// condition, not a bare label" ──────────────────────────────────────────────────────────────────

test("buildStatusBoard: QUEUE HEAD — the circuit-broken refused row carries dispatchCount/maxDispatches/resetNote, the SAME fields BLOCKERS' CircuitBrokenBlocker already renders, not a bare label", () => {
  const ledgerPath = writeLedger(tripBreakerLines("W1-T920"));
  const model = buildStatusBoard(tmpRoot(), ledgerPath, baseDeps());

  const row = model.queueHead.refused.find((r) => r.taskId === "W1-T920")!;
  assert.equal(row.dispatchCount, DEFAULT_MAX_TASK_DISPATCHES, "5 run.start lines, none reset");
  assert.equal(row.maxDispatches, DEFAULT_MAX_TASK_DISPATCHES);
  assert.match(row.resetNote ?? "", /resets only on a fresh owned PR for W1-T920/);
  assert.match(row.resetNote ?? "", /5\/5 dispatches/);

  // The SAME numbers BLOCKERS' own circuit_broken class renders for this task — one derivation,
  // read twice, never two independent computations that could disagree.
  const blockerRow = model.blockers.rows.find(
    (r): r is import("../src/lib/status-board.js").CircuitBrokenBlocker => r.kind === "circuit_broken" && r.taskId === "W1-T920",
  );
  assert.ok(blockerRow, "BLOCKERS also names this task's breaker trip");
  assert.equal(row.dispatchCount, blockerRow!.dispatchCount);
  assert.equal(row.resetNote, blockerRow!.resetNote);

  const text = renderStatusBoardText(model);
  assert.match(text, /REFUSED: W1-T920.*circuit breaker tripped/);
  assert.match(text, /5\/5 dispatches/);
});

// ── ACCEPTANCE 3: "the run-branch-already-pushed refusal keeps its existing row unchanged and is
// not displaced" ────────────────────────────────────────────────────────────────────────────────

test("buildStatusBoard: QUEUE HEAD — a circuit-broken exclusion and a run-branch-already-pushed exclusion coexist in `refused`, each keeping its OWN reason, neither displacing the other", () => {
  const threeTaskYaml = `
- id: W1-T901
  title: eligible
  repo: remudero
  type: implement
  verify: auto
  depends_on: []
  status: queued
- id: W1-T902
  title: circuit-broken
  repo: remudero
  type: implement
  verify: auto
  depends_on: []
  status: queued
- id: W1-T903
  title: run branch already pushed
  repo: remudero
  type: implement
  verify: auto
  depends_on: []
  status: queued
`;
  const threeTaskPlan = loadPlanFromYaml(threeTaskYaml, "fixture");
  const ledgerPath = writeLedger(tripBreakerLines("W1-T902"));
  const pushedBranch = "abc123\trefs/heads/run-W1-T903-1786886488695";
  const model = buildStatusBoard(
    tmpRoot(),
    ledgerPath,
    baseDeps({ plan: threeTaskPlan, readPushedRunBranches: () => pushedBranch }),
  );

  assert.deepEqual(model.queueHead.rows.map((r) => r.taskId), ["W1-T901"]);
  assert.equal(model.queueHead.refused.length, 2, "BOTH exclusions are named — one call, two reasons");

  const circuitRow = model.queueHead.refused.find((r) => r.taskId === "W1-T902")!;
  assert.equal(circuitRow.reason, "circuit-broken");
  assert.equal(circuitRow.dispatchCount, DEFAULT_MAX_TASK_DISPATCHES);

  // The pre-existing run-branch-already-pushed row is UNCHANGED — same shape as before this
  // task, no dispatchCount/maxDispatches/resetNote grafted onto a reason that never carried them.
  const branchRow = model.queueHead.refused.find((r) => r.taskId === "W1-T903")!;
  assert.equal(branchRow.reason, "run-branch-already-pushed");
  assert.equal(branchRow.dispatchCount, undefined, "the run-branch reason never carries breaker detail");
  assert.equal(branchRow.maxDispatches, undefined);
  assert.equal(branchRow.resetNote, undefined);

  const text = renderStatusBoardText(model);
  assert.match(text, /REFUSED: W1-T902.*circuit breaker tripped/);
  assert.match(text, /REFUSED: W1-T903.*run branch already pushed to origin/);
});

// ── ACCEPTANCE 4: "the refused list stays capped at the existing bound and still reports what it
// dropped" ───────────────────────────────────────────────────────────────────────────────────────

test("buildStatusBoard: QUEUE HEAD — `refused` stays capped at IDLE_REASON_ID_CAP across BOTH reasons combined, with `refusedTruncated` naming what didn't fit — the SAME shared bound, not a second cap per reason", () => {
  const manyIds = Array.from({ length: IDLE_REASON_ID_CAP + 3 }, (_, i) => `W1-T${9000 + i}`);
  const manyYaml = manyIds
    .map((id) => `- id: ${id}\n  title: t\n  repo: remudero\n  type: implement\n  verify: auto\n  depends_on: []\n  status: queued\n`)
    .join("");
  const manyPlan = loadPlanFromYaml(manyYaml, "fixture");
  const ledgerLines = manyIds.flatMap((id) => tripBreakerLines(id));
  const ledgerPath = writeLedger(ledgerLines);

  const model = buildStatusBoard(tmpRoot(), ledgerPath, baseDeps({ plan: manyPlan }));

  assert.deepEqual(model.queueHead.rows, [], "every candidate tripped its own breaker");
  assert.equal(model.queueHead.refused.length, IDLE_REASON_ID_CAP, "the visible list is capped, matching drain.ts's own bound");
  assert.equal(model.queueHead.refusedTruncated, manyIds.length - IDLE_REASON_ID_CAP, "and the drop is COUNTED, never silent");
  for (const row of model.queueHead.refused) assert.equal(row.reason, "circuit-broken");

  const text = renderStatusBoardText(model);
  assert.match(text, new RegExp(`\\+${manyIds.length - IDLE_REASON_ID_CAP} more`), "the truncation count reaches the rendered text too");
});

// ── ACCEPTANCE 5: "the DispatchFilterReason union still has six arms and gains none" ────────────

test("drain.ts: tallyDispatchFilters's DispatchFilterReason-keyed record still has exactly the original six arms — 'circuit-broken' is not one of them, because the breaker is not a DispatchFilterReason at all", () => {
  const tally = tallyDispatchFilters();
  runnableCandidates(plan(), NONE_MERGED, 10, {
    isCircuitTripped: (id) => id === "W1-T920",
    onFiltered: tally.onFiltered,
    // Deliberately NOT wiring onCircuitBreak here — proving the breaker's exclusion never
    // reaches `onFiltered`/the DispatchFilterReason tally even when nothing observes it.
  });
  const snapshot = tally.snapshot();
  // W1-T2474 adds one more arm, 'retired' (the 'blocked' bucket's own split) — the breaker's
  // own exclusion still lands in NONE of these, 'retired' included.
  // W1-T988: `foreign-repo` joins the enumeration. This list exists so a NEW arm cannot slip
  // in unnoticed — noticing it is the point, and the guard this assertion actually protects (no
  // `circuit-broken` arm) is untouched: the breaker is still not a DispatchFilterReason.
  assert.deepEqual(Object.keys(snapshot).sort(), [
    "already-merged",
    "blocked",
    "continued-this-pass",
    "credit-indeterminate",
    "foreign-repo",
    "retired",
    "run-branch-already-pushed",
    "unmet-deps",
    "verify-not-auto",
  ]);
  // The breaker exclusion never lands in ANY of these six buckets — it took the onCircuitBreak
  // path (unwired here) inside isDispatchEligible and returned before onFiltered was ever called
  // for it, so every bucket reads empty even though a task WAS excluded.
  for (const reason of Object.keys(snapshot) as Array<keyof typeof snapshot>) {
    assert.equal(snapshot[reason].count, 0, `'${reason}' must not have absorbed the circuit-broken exclusion`);
  }
});

// ── ACCEPTANCE 6: "no dispatch decision changes: the same tasks are eligible and the same tasks
// are refused" ──────────────────────────────────────────────────────────────────────────────────

test("buildStatusBoard: QUEUE HEAD's candidate set is byte-identical to runnableCandidates's own eligible set, WITH or WITHOUT onCircuitBreak wired — naming the exclusion is purely observational and changes no dispatch decision", () => {
  const lines = tripBreakerLines("W1-T920");
  const ledgerPath = writeLedger(lines);
  const model = buildStatusBoard(tmpRoot(), ledgerPath, baseDeps());
  const rowIds = model.queueHead.rows.map((r) => r.taskId);

  const isCircuitTripped = (id: string) => isDispatchBreakerTripped(lines, id);

  const withoutCallback = runnableCandidates(plan(), NONE_MERGED, 10, { isCircuitTripped }).map((t) => t.id);
  const withCallback = runnableCandidates(plan(), NONE_MERGED, 10, { isCircuitTripped, onCircuitBreak: () => {} }).map((t) => t.id);

  assert.deepEqual(rowIds, withoutCallback, "queue head's rows match the dispatcher's own eligible set");
  assert.deepEqual(withoutCallback, withCallback, "wiring onCircuitBreak changes NOTHING about which tasks are eligible");
});

// ── ACCEPTANCE 7: "a queue head with no tripped task prints no placeholder row" ──────────────────

test("buildStatusBoard: QUEUE HEAD — no task's breaker has tripped ⇒ `refused` names nothing for it, `rows` includes both tasks, and no placeholder circuit-broken row renders", () => {
  const ledgerPath = writeLedger([]);
  const model = buildStatusBoard(tmpRoot(), ledgerPath, baseDeps());

  assert.deepEqual(model.queueHead.refused, []);
  assert.deepEqual(
    model.queueHead.rows.map((r) => r.taskId).sort(),
    ["W1-T910", "W1-T920"],
  );
  assert.doesNotMatch(renderStatusBoardText(model), /REFUSED/);
  assert.doesNotMatch(renderStatusBoardText(model), /circuit breaker tripped/);
});

// ── ACCEPTANCE 8: "nothing added writes a ledger step or paces or sleeps a call" ─────────────────

test("buildStatusBoard: QUEUE HEAD — deriving the circuit-broken refusal writes NOTHING to the ledger; the file on disk is byte-identical before and after", () => {
  const ledgerPath = writeLedger(tripBreakerLines("W1-T920"));
  const before = readFileSync(ledgerPath, "utf8");
  buildStatusBoard(tmpRoot(), ledgerPath, baseDeps());
  const after = readFileSync(ledgerPath, "utf8");
  assert.equal(after, before, "a pure read/derive — no dispatch.circuit_broken or any other line is appended by this surface");
});
