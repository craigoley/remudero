import assert from "node:assert/strict";
import { test } from "node:test";

// The answered-clarification row re-armed the fix rung on EVERY sweep pass: an answer in
// plan/questions.ndjson was never spent, so #10564/#10565 (2026-10-10) read "operator answered the
// clarification question — re-dispatching" for hours on answers written two days earlier. An answer
// is spent once a fix round dispatches after it; it still rides later rounds as their constraint.

const sweep = await import("../src/lib/sweep.js");
const TASK = "W1-ANSWERED";

const answer = (ts: string) => ({ ts, task: TASK, answer: "use the head-only grep proof" });
const dispatch = (ts: string) => ({ ts, step: "fix.dispatch", task_id: TASK });

test("an answer older than the task's latest fix dispatch is spent and no longer re-arms the rung", () => {
  const evidence = sweep.operatorVerdictEvidence(TASK, [dispatch("2026-10-10T04:31:48Z")], [answer("2026-10-08T12:11:14Z")]);
  assert.ok(evidence, "the answer still exists as steering evidence");
  assert.equal(evidence.spent, true, "a dispatch after the answer spends it");
  assert.match(evidence.constraint, /head-only grep proof/, "a spent answer still steers later rounds");
});

test("an answer newer than the latest fix dispatch is live and re-arms the rung once", () => {
  const evidence = sweep.operatorVerdictEvidence(TASK, [dispatch("2026-10-10T04:31:48Z")], [answer("2026-10-10T05:00:00Z")]);
  assert.ok(evidence);
  assert.equal(evidence.spent, undefined, "an answer no round has carried yet is live");
});

test("a spent answer never claims the PR through the answered-clarification disposition row", () => {
  const rows = sweep.DISPOSITION_RULES as ReadonlyArray<{ reason: (...a: never[]) => string; when: (...a: never[]) => boolean }>;
  const row = rows.find((r) => {
    try { return /operator answered the clarification question/.test((r.reason as (pr: unknown) => string)({ priorStrikes: 0 })); }
    catch { return false; }
  });
  assert.ok(row, "the answered-clarification row exists");
  const pr = {
    pendingAnswer: { constraint: "x", spent: true }, reviewState: "failure", unmetCriteria: [{ id: "c1" }],
    priorStrikes: 0, progressEscalation: undefined, repeatedFixRefusal: undefined,
  };
  assert.equal((row.when as (p: unknown, policy: unknown) => boolean)(pr, sweep.DEFAULT_SWEEP_POLICY), false);
  const live = { ...pr, pendingAnswer: { constraint: "x" } };
  assert.equal((row.when as (p: unknown, policy: unknown) => boolean)(live, sweep.DEFAULT_SWEEP_POLICY), true);
});
