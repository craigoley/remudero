import assert from "node:assert/strict";
import test from "node:test";

import {
  buildRundown,
  haltsDrain,
  NON_HALTING_VERDICTS,
  runDrain,
  type DrainSummary,
} from "../src/lib/drain.js";
import { unmetDependencies, type Plan, type Task } from "../src/lib/plan.js";

/**
 * BOTH DIRECTIONS, ALWAYS. A test asserting only "blocked_ci no longer halts" would pass on a
 * change that removed the halt entirely — which would let a drain build on genuinely missing work.
 * So every continue-case here has a halt-case beside it, driven through the SAME `runDrain` with
 * the same fixture shape, differing only in the verdict returned.
 *
 * AND THE FIXTURE MUST REACH THE DECISION. `runDrain` filters candidates through its own
 * eligibility chain before it ever calls `runOne`, so a fixture whose tasks are filtered out would
 * exercise nothing and still go green. Every test below asserts `attempted` is non-empty, which is
 * only true if the loop actually reached the halt decision.
 */

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
        // A MERGED RESULT MUST BECOME VISIBLE TO THE NEXT `refreshMerged`, or the fixture re-offers
        // the same task forever and the test measures the fixture rather than the loop. Production
        // re-derives this from GitHub each iteration; a static set would not model that.
        if (r.merged) merged.add(id);
        return { taskId: id, runId: `R-${id}`, merged: r.merged, verdict: r.verdict, prUrl: r.prUrl, costUsd: 1 };
      },
      log: () => {},
    },
  };
}

test("haltsDrain: a blocked_ci result does NOT halt", () => {
  assert.equal(haltsDrain({ merged: false, verdict: "blocked_ci" }), false);
});

test("haltsDrain: a genuinely blocking verdict DOES halt — the set is a named few, not a hole", () => {
  // `no_pr` and later `blocked_illformed` BOTH LEFT this list when they joined
  // NON_HALTING_VERDICTS — see that set's own doc for each reversal and its argument. Every verdict
  // below still halts, and the size assertion is what stops the set being emptied wholesale by a
  // later change.
  for (const v of ["blocked", "blocked_review", "failed", "blocked_budget", "blocked_containment"]) {
    assert.equal(haltsDrain({ merged: false, verdict: v }), true, `${v} must still halt`);
  }
  assert.equal(NON_HALTING_VERDICTS.size, 3, "exactly three verdicts are exempt");
});

test("runDrain CONTINUES past a blocked_ci and spends its remaining budget", async () => {
  const p = plan([task("A"), task("B")]);
  const { calls, deps } = drainDeps(
    { A: { merged: false, verdict: "blocked_ci", prUrl: "https://x/1" }, B: { merged: true, verdict: "merged" } },
    new Set(),
  );
  const s = (await runDrain(p, deps as never, { max: 2 })) as DrainSummary;
  assert.ok(s.attempted.length > 0, "fixture must reach the halt decision");
  assert.deepEqual(calls, ["A", "B"], "the drain must go on to dispatch B");
  assert.deepEqual(s.merged, ["B"], "a continued task is NOT credited as merged");
  assert.deepEqual(
    (s.continued ?? []).map((c) => c.taskId),
    ["A"],
    "the continued task is recorded",
  );
});

test("runDrain still HALTS on a genuinely blocking verdict — same fixture, verdict swapped", async () => {
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

test("a dependent of a continued task is STILL refused — the dependency filter, not the halt, is what prevents building on missing work", () => {
  const p = plan([task("A"), task("B", ["A"])]);
  // `A` returned blocked_ci: its PR is open, so the merge resolver still reports it unmerged.
  const isMerged = (t: Task) => false;
  assert.deepEqual(
    unmetDependencies(p, p.byId.get("B")!, isMerged),
    ["A"],
    "B's dependency on the continued task A is unmet, so B cannot be dispatched",
  );
});

test("buildRundown gives a continued task its OWN detail, never the drain's stopDetail", () => {
  const summary: DrainSummary = {
    attempted: ["A", "B"],
    merged: [],
    continued: [{ taskId: "A", verdict: "blocked_ci", prUrl: "https://x/1" }],
    stopReason: "blocked",
    stopDetail: "B → failed",
    costUsd: 2,
    resumeCommand: "rmd drain",
  };
  const lines = buildRundown(summary);
  const a = lines.find((l) => l.taskId === "A")!;
  const b = lines.find((l) => l.taskId === "B")!;
  assert.match(String(a.detail), /blocked_ci/, "A must carry its own verdict");
  assert.doesNotMatch(String(a.detail), /failed/, "A must NOT borrow B's stopDetail");
  assert.equal(b.detail, "B → failed", "the halting task keeps the drain's stopDetail");
});

test("a continued task is never re-offered in the same pass, even with no open-PR check wired", async () => {
  // THE HOLE THIS CHANGE OPENED, AND ITS GUARD. Continuing past a non-merged task means the
  // selector will offer it again — it is still unmerged and still eligible. Production would
  // usually be saved by `isOpenPr`, but that dep is OPTIONAL; this fixture deliberately omits it,
  // which is exactly the shape that re-dispatched one task forever before the exclusion existed.
  const p = plan([task("A"), task("B")]);
  const { calls, deps } = drainDeps(
    { A: { merged: false, verdict: "blocked_ci", prUrl: "https://x/1" }, B: { merged: true, verdict: "merged" } },
    new Set(),
  );
  const s = (await runDrain(p, deps as never, { max: 4 })) as DrainSummary;
  assert.ok(s.attempted.length > 0, "fixture must reach the halt decision");
  assert.equal(calls.filter((c) => c === "A").length, 1, "A must be dispatched exactly once");
  assert.deepEqual(calls, ["A", "B"], "and the pass must move on rather than loop");
});

test("the PARALLEL-lane loop applies the same rule: a blocked_ci lane continues, a blocking lane halts", async () => {
  // BOTH LOOPS OR NEITHER. The single-lane and parallel-lane paths drifting apart is a documented
  // hazard in this module, so the lane path is driven through the SAME predicate here — a halt
  // rule that differed between them would be invisible until someone raised the lane count.
  const p = plan([task("A"), task("B")]);
  const ci = drainDeps(
    { A: { merged: false, verdict: "blocked_ci", prUrl: "https://x/1" }, B: { merged: true, verdict: "merged" } },
    new Set(),
  );
  const sCi = (await runDrain(p, ci.deps as never, { max: 2, laneCount: 2 })) as DrainSummary;
  assert.ok(sCi.attempted.length > 0, "fixture must reach the lane halt decision");
  assert.notEqual(sCi.stopReason, "blocked", "a blocked_ci lane must not stop the pass");
  assert.deepEqual((sCi.continued ?? []).map((c) => c.taskId), ["A"]);
  assert.deepEqual(sCi.merged, ["B"], "the sibling lane's merge still counts");

  const hard = drainDeps(
    { A: { merged: false, verdict: "failed" }, B: { merged: true, verdict: "merged" } },
    new Set(),
  );
  const sHard = (await runDrain(p, hard.deps as never, { max: 2, laneCount: 2 })) as DrainSummary;
  assert.ok(sHard.attempted.length > 0, "fixture must reach the lane halt decision");
  assert.equal(sHard.stopReason, "blocked", "a genuinely blocking lane still stops the pass");
  assert.deepEqual(sHard.continued ?? [], []);
});
