/**
 * `no_pr` JOINS `NON_HALTING_VERDICTS` — and this REVERSES a documented decision, so the argument
 * is locked here as well as in that set's own doc.
 *
 * WHAT WAS ARGUED BEFORE: "nothing was produced at all, which is strictly worse than a block, and
 * its own doc argues the halt explicitly (`a blind auto-retry carries NO new information`)."
 *
 * WHY IT DOES NOT SURVIVE. "Strictly worse" ranks the RUN's value; the halt answers a different
 * question — whether continuing COMPOUNDS a gap. The drain header's own justification is that "a
 * blocked task's DEPENDENTS would build on missing work". A `no_pr` run produced nothing and
 * advanced nothing, so its dependents face the state they started from — and they cannot be
 * selected in any case, because `isDispatchEligible` filters `unmetDependencies(...).length > 0`
 * as `unmet-deps` and is the SINGLE predicate behind both `nextRunnable` and `runnableCandidates`.
 * The dependency machinery protects dependents; the halt never did. The last test in this file
 * asserts that directly rather than taking it on trust.
 *
 * AND THE HALT NEVER PREVENTED THE RETRY IT WORRIED ABOUT: a later pass re-offers the task either
 * way. All it prevented was OTHER tasks running now. Measured cost on the container path, where
 * the header's other justification ("a human kicked it off by hand and is watching it") is false:
 * four dispatches ended `no_pr` in one day and one drain stopped after two of a `--max 6` budget.
 *
 * BOTH DIRECTIONS, ALWAYS. A test asserting only "no_pr no longer halts" would pass on a change
 * that emptied the halt set entirely. Every continue-case here has a halt-case beside it through
 * the SAME `runDrain`, differing in ONE variable — the verdict returned.
 *
 * AND THE FIXTURE MUST REACH THE DECISION: `runDrain` filters candidates before it ever calls
 * `runOne`, so every test asserts `attempted` is non-empty, which only holds if the loop actually
 * reached the halt decision.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { haltsDrain, NON_HALTING_VERDICTS, runDrain, type DrainSummary } from "../src/lib/drain.js";
import { unmetDependencies, type Plan, type Task } from "../src/lib/plan.js";

function task(id: string, depends_on: string[] = []): Task {
  return {
    id,
    title: id,
    repo: "remudero",
    depends_on,
    type: "implement",
    verify: "auto",
    risk: "low",
    status: "queued",
    attempts: 0,
    files: [],
    acceptance: [],
  } as unknown as Task;
}

function plan(tasks: Task[]): Plan {
  return { tasks, byId: new Map(tasks.map((t) => [t.id, t])) } as unknown as Plan;
}

function drainDeps(
  results: Record<string, { merged: boolean; verdict: string; prUrl?: string }>,
  merged: Set<string>,
) {
  const calls: string[] = [];
  return {
    calls,
    deps: {
      refreshMerged: () => (id: string) => merged.has(id),
      runOne: async (id: string) => {
        calls.push(id);
        const r = results[id];
        if (r.merged) merged.add(id);
        return { taskId: id, runId: `R-${id}`, merged: r.merged, verdict: r.verdict, prUrl: r.prUrl, costUsd: 1 };
      },
      log: () => {},
    },
  };
}

test("haltsDrain: a no_pr result no longer halts, while every genuinely blocking verdict still does", () => {
  assert.equal(haltsDrain({ merged: false, verdict: "no_pr" }), false, "no_pr must not halt");

  // THE CONTROL that stops this passing against an emptied set.
  for (const v of [
    "blocked",
    "blocked_review",
    "blocked_containment",
    "blocked_isolation",
    "blocked_illformed",
    "blocked_budget",
    "blocked_transient",
    "blocked_git_fetch",
    "blocked_inflight",
    "pr_attribution_failed",
    "failed",
  ]) {
    assert.equal(haltsDrain({ merged: false, verdict: v }), true, `${v} must still halt`);
  }
  assert.deepEqual([...NON_HALTING_VERDICTS].sort(), ["blocked_ci", "no_pr"], "the exempt set is exactly this pair");
});

test("runDrain CONTINUES past a no_pr and spends the rest of its budget on other work", async () => {
  const p = plan([task("A"), task("B")]);
  // A no_pr run has NO prUrl — that is the whole shape of the verdict.
  const { calls, deps } = drainDeps(
    { A: { merged: false, verdict: "no_pr" }, B: { merged: true, verdict: "merged" } },
    new Set(),
  );
  const s = (await runDrain(p, deps as never, { max: 2 })) as DrainSummary;
  assert.ok(s.attempted.length > 0, "fixture must reach the halt decision");
  assert.deepEqual(calls, ["A", "B"], "the drain must go on to dispatch B");
  assert.deepEqual(s.merged, ["B"], "a continued task is NOT credited as merged");
  assert.deepEqual(
    (s.continued ?? []).map((c) => c.taskId),
    ["A"],
    "the no_pr task is recorded as continued, never as done",
  );
});

test("runDrain still HALTS on a genuinely blocking verdict — the same fixture with only the verdict swapped", async () => {
  const p = plan([task("A"), task("B")]);
  const { calls, deps } = drainDeps(
    { A: { merged: false, verdict: "blocked" }, B: { merged: true, verdict: "merged" } },
    new Set(),
  );
  const s = (await runDrain(p, deps as never, { max: 2 })) as DrainSummary;
  assert.ok(s.attempted.length > 0, "fixture must reach the halt decision");
  assert.deepEqual(calls, ["A"], "B must never be dispatched");
  assert.equal(s.stopReason, "blocked");
  assert.deepEqual(s.continued ?? [], [], "a halting verdict is never recorded as continued");
});

test("a no_pr task is dispatched exactly once per pass — continuing past it does not re-offer it", async () => {
  // A no_pr task is still unmerged and still eligible, and unlike blocked_ci it has NO open PR for
  // `isOpenPr` to catch, so the in-pass exclusion is the ONLY thing standing between this verdict
  // and a same-pass loop. Budget deliberately exceeds the task count so a loop would be visible.
  const p = plan([task("A"), task("B")]);
  const { calls, deps } = drainDeps(
    { A: { merged: false, verdict: "no_pr" }, B: { merged: true, verdict: "merged" } },
    new Set(),
  );
  const s = (await runDrain(p, deps as never, { max: 4 })) as DrainSummary;
  assert.ok(s.attempted.length > 0, "fixture must reach the halt decision");
  assert.equal(calls.filter((c) => c === "A").length, 1, "A must be dispatched exactly once");
  assert.deepEqual(calls, ["A", "B"], "and the pass must move on rather than loop");
});

test("the parallel-lane loop applies the same rule: a no_pr lane continues, a blocking lane halts", async () => {
  // BOTH LOOPS OR NEITHER — the single-lane and parallel-lane paths drifting apart is a documented
  // hazard in this module, so the lane path is driven through the same predicate here.
  const p = plan([task("A"), task("B")]);
  const soft = drainDeps(
    { A: { merged: false, verdict: "no_pr" }, B: { merged: true, verdict: "merged" } },
    new Set(),
  );
  const sSoft = (await runDrain(p, soft.deps as never, { max: 2, laneCount: 2 })) as DrainSummary;
  assert.ok(sSoft.attempted.length > 0, "fixture must reach the lane halt decision");
  assert.notEqual(sSoft.stopReason, "blocked", "a no_pr lane must not stop the pass");
  assert.deepEqual((sSoft.continued ?? []).map((c) => c.taskId), ["A"]);
  assert.deepEqual(sSoft.merged, ["B"], "the sibling lane's merge still counts");

  const hard = drainDeps({ A: { merged: false, verdict: "failed" }, B: { merged: true, verdict: "merged" } }, new Set());
  const sHard = (await runDrain(p, hard.deps as never, { max: 2, laneCount: 2 })) as DrainSummary;
  assert.ok(sHard.attempted.length > 0, "fixture must reach the lane halt decision");
  assert.equal(sHard.stopReason, "blocked", "a failing lane still stops the pass");
});

test("a dependent of a no_pr task is still refused — the dependency filter, not the halt, protects it", () => {
  // The header justifies stop-on-block by "a blocked task's DEPENDENTS would build on missing
  // work". This asserts the protection survives the halt's removal for this verdict: B depends on
  // A, A produced nothing and is unmerged, so B's dependency is unmet and it cannot be selected.
  const p = plan([task("A"), task("B", ["A"])]);
  const noneMerged = () => false;
  assert.deepEqual(
    unmetDependencies(p, p.byId.get("B")!, noneMerged),
    ["A"],
    "B's dependency on the no_pr task A is unmet, so B is filtered before dispatch",
  );
});
