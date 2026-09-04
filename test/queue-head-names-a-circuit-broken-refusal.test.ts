import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { loadPlanFromYaml } from "../src/lib/plan.js";
import { IDLE_REASON_ID_CAP, runnableCandidates, type MergedSet } from "../src/lib/drain.js";
import { deriveQueueHead, renderQueueHeadBlock } from "../src/lib/status-board.js";
import { DEFAULT_MAX_TASK_DISPATCHES, type StatusProjection } from "../src/lib/status.js";

// ── W1-T2415: THE QUEUE HEAD DROPS A CIRCUIT-BROKEN TASK AND NEVER SAYS WHY.
//
// THE PREMISE IS THE SHARD'S CORRECTED ONE, NOT ITS BRIEF'S. The breaker is NOT refused above
// the selector: `opts.isCircuitTripped?.(t.id)` sits INSIDE `isDispatchEligible` (drain.ts),
// calls `onCircuitBreak`, and returns false — so a tripped task is `isDispatchEligible === false`
// and never sorts anywhere. And `CircuitBrokenBlocker` DOES render it, with `dispatchCount`,
// `maxDispatches` and a `resetNote`.
//
// THE REAL DEFECT IS NARROWER. `deriveQueueHead` calls `runnableCandidates` with THREE predicates
// (`isIndeterminate`, `isCircuitTripped`, `hasPushedRunBranch`) and ONE observation callback
// (`onFiltered`). `onCircuitBreak` and `onIndeterminate` are both accepted `NextRunnableOpts`
// keys and NEITHER was passed — each read 0 occurrences across `src/lib/status-board.ts`. So the
// predicate removed the task from `rows` and the callback that would have named it was never
// supplied, while `onFiltered`'s `if (reason !== "run-branch-already-pushed") return;` gave the
// sibling exclusion from the very same call a `refused` row.
//
// NOT A SEVENTH `DispatchFilterReason` ARM. That would widen the union, `IdleReasonTally`,
// `tallyDispatchFilters` and `QueueHeadRefusedRow.reason`, and contradict the union doc's own
// stated reasoning that the circuit "already ledgers itself through its own dedicated `onXxx`
// callback". This takes that doc at its word and supplies the callback — matching how `runDaemon`
// (daemon.ts) already collects ids for `StarvationCensus` with `circuitBrokenThisTick`.

const NONE_MERGED: MergedSet = () => false;
const NOW_MS = Date.parse("2026-08-27T23:00:00.000Z");

function planOf(ids: readonly string[]) {
  return loadPlanFromYaml(
    ids
      .map((id) => `- id: ${id}\n  title: task ${id}\n  repo: remudero\n  type: implement\n  verify: auto\n  depends_on: []\n  status: queued\n`)
      .join(""),
    "fixture",
  );
}

function projectionsFor(ids: readonly string[]): Map<string, StatusProjection> {
  return new Map(ids.map((id) => [id, { merged: false } as StatusProjection]));
}

/** `isDispatchBreakerTripped` counts `run.start` since the last `pr.opened`/merge credit, so
 *  `DEFAULT_MAX_TASK_DISPATCHES` bare run.starts is exactly a tripped task. */
function trippedRows(taskId: string): Array<Record<string, unknown>> {
  return Array.from({ length: DEFAULT_MAX_TASK_DISPATCHES }, (_, i) => ({
    ts: `2026-08-24T0${i}:00:00.000Z`,
    step: "run.start",
    task_id: taskId,
    run_id: `${taskId}-${i}`,
  }));
}

test("W1-T2415: a circuit-broken task is named on the queue head's refused list instead of vanishing from it", () => {
  const ids = ["W1-TOK", "W1-TTRIP"];
  const head = deriveQueueHead(planOf(ids), trippedRows("W1-TTRIP"), projectionsFor(ids), undefined, 5, NOW_MS);
  assert.deepEqual(head.rows.map((r) => r.taskId), ["W1-TOK"], "the tripped task is still correctly excluded from rows");
  assert.deepEqual(
    head.refused.map((r) => ({ taskId: r.taskId, reason: r.reason })),
    [{ taskId: "W1-TTRIP", reason: "circuit-broken" }],
    "and is now NAMED rather than vanishing with no trace on this surface",
  );
});

test("W1-T2415: the named refusal carries the dispatch count and the breaker's own reset condition, not a bare label", () => {
  const ids = ["W1-TTRIP"];
  const head = deriveQueueHead(planOf(ids), trippedRows("W1-TTRIP"), projectionsFor(ids), undefined, 5, NOW_MS);
  const [row] = head.refused;
  assert.equal(row?.dispatchCount, DEFAULT_MAX_TASK_DISPATCHES, "the SAME streak count the breaker itself tripped on");
  assert.equal(row?.maxDispatches, DEFAULT_MAX_TASK_DISPATCHES);
  assert.equal(
    row?.resetNote,
    `resets only on a fresh owned PR for W1-TTRIP — ${DEFAULT_MAX_TASK_DISPATCHES}/${DEFAULT_MAX_TASK_DISPATCHES} dispatches since the last one`,
    "the reset note is BLOCKERS' own wording, reused rather than a second phrasing that could drift",
  );
});

test("W1-T2415: the run-branch-already-pushed refusal keeps its existing row unchanged and is not displaced", () => {
  const ids = ["W1-TBRANCH", "W1-TTRIP"];
  const head = deriveQueueHead(
    planOf(ids),
    trippedRows("W1-TTRIP"),
    projectionsFor(ids),
    undefined,
    5,
    NOW_MS,
    (id) => id === "W1-TBRANCH",
  );
  const byId = new Map(head.refused.map((r) => [r.taskId, r]));
  assert.equal(byId.get("W1-TBRANCH")?.reason, "run-branch-already-pushed", "the W1-T1205 row is untouched");
  assert.equal(byId.get("W1-TBRANCH")?.dispatchCount, undefined, "and carries no breaker fields it never had");
  assert.equal(byId.get("W1-TTRIP")?.reason, "circuit-broken", "both are named — neither displaces the other");
  assert.equal(head.refused.length, 2);
});

test("W1-T2415: the refused list stays capped at the existing bound and still reports what it dropped", () => {
  const tripped = Array.from({ length: IDLE_REASON_ID_CAP + 3 }, (_, i) => `W1-TT${i}`);
  const lines = tripped.flatMap((id) => trippedRows(id));
  const head = deriveQueueHead(planOf(tripped), lines, projectionsFor(tripped), undefined, 5, NOW_MS);
  assert.equal(head.refused.length, IDLE_REASON_ID_CAP, "capped at drain.ts's OWN bound, not a second constant");
  assert.equal(head.refusedTruncated, 3, "and it says how many it could not name");
});

test("W1-T2415: a queue head with no tripped task prints no placeholder row", () => {
  const ids = ["W1-TOK"];
  const head = deriveQueueHead(planOf(ids), [], projectionsFor(ids), undefined, 5, NOW_MS);
  assert.deepEqual(head.refused, [], "empty when nothing was refused — never a placeholder");
  assert.equal(head.refusedTruncated, 0);
  assert.equal(renderQueueHeadBlock(head).some((l) => l.startsWith("REFUSED:")), false, "and nothing is rendered");
});

test("W1-T2415: the rendered line names the breaker, never the run-branch reason", () => {
  const ids = ["W1-TBRANCH", "W1-TTRIP"];
  const head = deriveQueueHead(
    planOf(ids),
    trippedRows("W1-TTRIP"),
    projectionsFor(ids),
    undefined,
    5,
    NOW_MS,
    (id) => id === "W1-TBRANCH",
  );
  const out = renderQueueHeadBlock(head);
  const trip = out.find((l) => l.includes("W1-TTRIP"));
  const branch = out.find((l) => l.includes("W1-TBRANCH"));
  assert.ok(trip?.includes("circuit breaker"), `the breaker row must say so — got: ${trip}`);
  assert.equal(trip?.includes("run branch already pushed"), false, "and must NOT inherit the sibling's label");
  assert.ok(branch?.includes("run branch already pushed to origin"), "the sibling's own wording is unchanged");
  assert.ok(head.nextAction?.includes("W1-TTRIP") || head.nextAction?.includes("W1-TBRANCH"), "a next action is still chosen");
});

test("W1-T2415: no dispatch decision changes — the same tasks are eligible and the same tasks are refused", () => {
  const ids = ["W1-TOK", "W1-TTRIP"];
  const lines = trippedRows("W1-TTRIP");
  const isCircuitTripped = (id: string) => id === "W1-TTRIP";
  const withCallback = runnableCandidates(planOf(ids), NONE_MERGED, 5, { isCircuitTripped, onCircuitBreak: () => {} });
  const without = runnableCandidates(planOf(ids), NONE_MERGED, 5, { isCircuitTripped });
  assert.deepEqual(withCallback.map((t) => t.id), without.map((t) => t.id), "the observation callback never gates");
  const head = deriveQueueHead(planOf(ids), lines, projectionsFor(ids), undefined, 5, NOW_MS);
  assert.deepEqual(head.rows.map((r) => r.taskId), without.map((t) => t.id), "queue head rows still match the selector");
});

test("W1-T2415: the DispatchFilterReason union gains no CIRCUIT-BREAKER arm (W1-T2474 adds 'retired', unrelated to this guard)", () => {
  const drain = readFileSync(new URL("../src/lib/drain.ts", import.meta.url), "utf8");
  const decl = drain.slice(drain.indexOf("export type DispatchFilterReason ="));
  const body = decl.slice(0, decl.indexOf(";"));
  const arms = [...body.matchAll(/\|\s*"([a-z-]+)"/g)].map((m) => m[1]);
  assert.deepEqual(
    arms,
    ["already-merged", "verify-not-auto", "blocked", "retired", "unmet-deps", "continued-this-pass", "credit-indeterminate", "run-branch-already-pushed"],
    "the union gains W1-T2474's 'retired' (blocked's own split) and W1-T2675's 'credit-indeterminate' (a credit read that FAILED, told apart from a credit that was SEEN) — the breaker is still named through its own callback, not an arm here",
  );
  assert.equal(body.includes("circuit"), false, "and no circuit arm was smuggled in");
});

test("W1-T2415: nothing added writes a ledger step or paces or sleeps a call", () => {
  const src = readFileSync(new URL("../src/lib/status-board.ts", import.meta.url), "utf8");
  const fn = src.slice(src.indexOf("export function deriveQueueHead"));
  const body = fn.slice(0, fn.indexOf("\n}\n") + 3);
  for (const banned of ["appendLedger", "log(", "setTimeout", "setInterval", "await "]) {
    assert.equal(body.includes(banned), false, `deriveQueueHead must stay a synchronous pure read — found ${banned}`);
  }
});
