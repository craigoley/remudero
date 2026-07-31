import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadPlan, type Plan } from "../src/lib/plan.js";
import {
  nextRunnable,
  runnableCandidates,
  type MergedSet,
} from "../src/lib/drain.js";
import {
  DEFAULT_MAX_TASK_LIFETIME_DISPATCHES,
  dispatchesEver,
  dispatchesWithoutNewOwnedPr,
  isLifetimeDispatchCapExceeded,
} from "../src/lib/status.js";

// W1-T271 — THE LOOP THAT SUCCEEDS: dispatchesWithoutNewOwnedPr (the existing streak
// breaker) resets to 0 on every pr.opened line, so a task that re-dispatches forever
// while merging a genuine no-op PR each time (W1-T254, OBSERVED 2026-07-31: five
// dispatches in eighty minutes) never trips it. dispatchesEver / isLifetimeDispatchCapExceeded
// are the sibling, never-reset counter this task adds.

// A small linear-ish plan: A → B → C (chain) + D (independent), all auto — mirrors
// drain.test.ts's own fixture so this file needs no shared import.
const YAML = `
- id: A
  title: a
  repo: remudero
  type: implement
  depends_on: []
  status: queued
- id: D
  title: d
  repo: remudero
  type: implement
  depends_on: []
  status: queued
`;

function fixturePlan(): Plan {
  const dir = mkdtempSync(join(tmpdir(), "dispatch-lifetime-breaker-"));
  const f = join(dir, "tasks.yaml");
  writeFileSync(f, YAML);
  return loadPlan(f);
}

const NONE_MERGED: MergedSet = () => false;

// ── dispatchesEver: the raw counter ─────────────────────────────────────────

test("dispatchesEver: counts every run.start line for a task across its whole history", () => {
  const lines = [
    { task_id: "W1-T254", step: "run.start" },
    { task_id: "OTHER", step: "run.start" }, // a different task must never contribute
    { task_id: "W1-T254", step: "run.start" },
    { task_id: "W1-T254", step: "run.start" },
  ];
  assert.equal(dispatchesEver(lines, "W1-T254"), 3);
});

test("dispatchesEver: a task never dispatched at all counts zero", () => {
  assert.equal(dispatchesEver([], "W1-T254"), 0);
});

// ── THE ACTUAL BUG THIS TASK FIXES: pr.opened must NOT reset this counter,
// unlike the existing streak counter it sits alongside ────────────────────

test("dispatchesEver: UNAFFECTED by pr.opened lines that reset the sibling streak counter to 0", () => {
  const lines = [
    { task_id: "W1-T254", step: "run.start" },
    { task_id: "W1-T254", step: "pr.opened", pr_url: "u/1" },
    { task_id: "W1-T254", step: "run.start" },
    { task_id: "W1-T254", step: "pr.opened", pr_url: "u/2" },
    { task_id: "W1-T254", step: "run.start" },
    { task_id: "W1-T254", step: "pr.opened", pr_url: "u/3" },
  ];
  // The streak breaker sees 0 (reset by the LAST pr.opened) — this is the exact
  // shape (dispatch, merge, dispatch, merge, ...) that let W1-T254 evade it.
  assert.equal(dispatchesWithoutNewOwnedPr(lines, "W1-T254"), 0, "sanity: the streak counter IS reset by each pr.opened");
  // The lifetime counter must see all THREE run.start lines regardless.
  assert.equal(dispatchesEver(lines, "W1-T254"), 3, "the lifetime counter must survive every pr.opened line");
});

// ── isLifetimeDispatchCapExceeded ────────────────────────────────────────────

test("isLifetimeDispatchCapExceeded: trips at exactly N lifetime dispatches, not N-1, even with a pr.opened between every dispatch", () => {
  const dispatchThenMerge = (taskId: string, n: number) => {
    const out: Array<Record<string, unknown>> = [];
    for (let i = 0; i < n; i++) {
      out.push({ task_id: taskId, step: "run.start" });
      out.push({ task_id: taskId, step: "pr.opened", pr_url: `u/${i}` });
    }
    return out;
  };
  const nMinus1 = dispatchThenMerge("W1-T254", DEFAULT_MAX_TASK_LIFETIME_DISPATCHES - 1);
  const n = dispatchThenMerge("W1-T254", DEFAULT_MAX_TASK_LIFETIME_DISPATCHES);
  assert.equal(isLifetimeDispatchCapExceeded(nMinus1, "W1-T254"), false, "N-1 lifetime dispatches must not trip the cap yet");
  assert.equal(isLifetimeDispatchCapExceeded(n, "W1-T254"), true, "the Nth lifetime dispatch trips it, even though every one of them opened its own PR");
  // The streak breaker, by contrast, sees this exact ledger as perpetually clear —
  // this is the whole reason the lifetime cap exists.
  assert.equal(dispatchesWithoutNewOwnedPr(n, "W1-T254"), 0, "the streak breaker alone would never trip on this shape");
});

test("isLifetimeDispatchCapExceeded: a policy-data override (rule 2) changes the cap with zero code changes", () => {
  const twoDispatches = [
    { task_id: "W1-T254", step: "run.start" },
    { task_id: "W1-T254", step: "run.start" },
  ];
  assert.equal(isLifetimeDispatchCapExceeded(twoDispatches, "W1-T254"), false, "under the default cap, 2 dispatches is not tripped");
  assert.equal(isLifetimeDispatchCapExceeded(twoDispatches, "W1-T254", 2), true, "an overridden cap of 2 trips at exactly 2");
});

// ── wired into isDispatchEligible (via nextRunnable/runnableCandidates, its two
// exported callers) — mirrors the existing isCircuitTripped tests in drain.test.ts ──

test("W1-T271: a task past the lifetime cap is refused by isDispatchEligible (nextRunnable), with a legible callback naming it", () => {
  const plan = fixturePlan(); // A, D — both independent and otherwise runnable
  const capped: string[] = [];
  const next = nextRunnable(plan, NONE_MERGED, {
    isLifetimeCapExceeded: (id) => id === "A",
    onLifetimeCapExceeded: (t) => capped.push(t.id),
  });
  assert.deepEqual(capped, ["A"]);
  assert.equal(next?.id, "D", "A is skipped for its lifetime cap; D is the next runnable task");
});

test("W1-T271: the lifetime cap is independent of the streak breaker — both may be wired, either can halt a task on its own", () => {
  const plan = fixturePlan();
  const capped: string[] = [];
  const broken: string[] = [];
  const next = nextRunnable(plan, NONE_MERGED, {
    isCircuitTripped: () => false, // streak breaker clear
    onCircuitBreak: (t) => broken.push(t.id),
    isLifetimeCapExceeded: (id) => id === "A", // lifetime cap alone halts A
    onLifetimeCapExceeded: (t) => capped.push(t.id),
  });
  assert.deepEqual(broken, [], "the streak breaker never fires when it reports clear");
  assert.deepEqual(capped, ["A"], "the lifetime cap halts A on its own, independent of the streak breaker's verdict");
  assert.equal(next?.id, "D");
});

test("W1-T271: runnableCandidates applies the exact same lifetime-cap gate as nextRunnable", () => {
  const plan = fixturePlan();
  const capped: string[] = [];
  const candidates = runnableCandidates(plan, NONE_MERGED, 5, {
    isLifetimeCapExceeded: (id) => id === "A",
    onLifetimeCapExceeded: (t) => capped.push(t.id),
  });
  assert.deepEqual(capped, ["A"]);
  assert.deepEqual(candidates.map((t) => t.id), ["D"], "A is excluded from the concurrent candidate list too");
});

test("W1-T271: no isLifetimeCapExceeded wired at all ⇒ nextRunnable behaves exactly as before this cap existed", () => {
  const plan = fixturePlan();
  assert.equal(nextRunnable(plan, NONE_MERGED)?.id, "A");
});
