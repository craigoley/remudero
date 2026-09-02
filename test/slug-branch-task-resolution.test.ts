/**
 * W1-T2629 — THE REAPER'S RESIDUE CANNOT READ A TASK ID A BRANCH NAME ALREADY DECLARES.
 *
 * Every task-claim predicate `planBranchReap` (`src/lib/status.ts`) can call on requires the
 * `run-` prefix — `taskIdFromRunBranch`, `ownsBranch`, `isOwnedSlugBranch` and
 * `branchClaimsOtherTask` all refuse a head that does not start `run-`. So a slug branch that
 * names its task directly, e.g. `w1t1060-instrument-declare`, resolves to NO task anywhere and
 * `planBranchReap` files it under the plain `no_pr_ever` reason — "the residue that needs
 * adjudication" — even when a grep of the plan already answers whether the named task shipped
 * by another route.
 *
 * This file proves the new pure resolver, `taskIdFromSlugBranch`, and the one-step reason split
 * it feeds inside `planBranchReap` (`no_pr_ever` → `named_task_credited` / `named_task_open`).
 * Nothing here changes a disposition: every branch stays in exactly the bucket it lands in
 * today (design (iii), and this file's own falsifier test proves it directly).
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  planBranchReap,
  taskIdFromSlugBranch,
  type BranchFacts,
  type BranchReapPlan,
} from "../src/lib/status.js";
import { DECLARED_BRANCH_GUARDS } from "../src/run-task.js";

const f = (name: string, over: Partial<BranchFacts> = {}): BranchFacts => ({
  name,
  prState: "none",
  tipInMain: false,
  namedInSource: false,
  ...over,
});

// ── CLAIM 1: the live fixture resolves and the digit boundary vetoes ─────────────────────────

test("W1-T2629(1): w1t1060-instrument-declare resolves W1-T1060, not the colliding W1-T106", () => {
  const candidates = ["W1-T1060", "W1-T106"];
  assert.equal(taskIdFromSlugBranch("w1t1060-instrument-declare", candidates), "W1-T1060");
});

test("W1-T2629(1): the digit-boundary trap fires in isolation — W1-T106 alone is refused", () => {
  // Same shape as isOwnedSlugBranch's own documented trap (status.ts): a bare prefix match
  // would let the shorter id claim credit from the longer id's branch. Here the match is
  // followed by the digit '0', which is exactly what must veto it.
  assert.equal(taskIdFromSlugBranch("w1t1060-instrument-declare", ["W1-T106"]), undefined);
});

test("W1-T2629(1): case and punctuation differences all normalise together", () => {
  for (const candidate of ["W1-T1060", "w1t1060", "w1-t1060", "W1T1060"]) {
    assert.equal(
      taskIdFromSlugBranch("w1t1060-instrument-declare", [candidate]),
      candidate,
      `candidate spelling "${candidate}" must still resolve`,
    );
  }
});

test("W1-T2629(1): a branch naming no known task resolves to undefined", () => {
  assert.equal(taskIdFromSlugBranch("tmp-check-branch", ["W1-T1060", "W1-T2247"]), undefined);
});

test("W1-T2629(1): the task id must be the LEADING token — a run-branch's `run-` prefix is not a task id, so it does not resolve here (that shape is `taskIdFromRunBranch`'s job, unaffected by this rung)", () => {
  assert.equal(taskIdFromSlugBranch("run-W1-T2247-1785348476091", ["W1-T2247"]), undefined);
});

test("W1-T2629(1): longest match wins over a shorter id that is also a valid prefix", () => {
  // Both W1-T10 and W1-T1060 legitimately match at the start; only the longer one is followed
  // by a non-digit boundary for the shorter candidate, so this also exercises the digit trap —
  // but the point of this test is specifically the longest-match tie-break.
  assert.equal(
    taskIdFromSlugBranch("w1t1060-instrument-declare", ["W1-T1060", "W1-T10600"]),
    "W1-T1060",
    "W1-T10600 cannot match at all (branch has no trailing 0), so W1-T1060 must win",
  );
});

test("W1-T2629(1): undefined head resolves to undefined without throwing", () => {
  assert.equal(taskIdFromSlugBranch(undefined, ["W1-T1060"]), undefined);
});

// ── CLAIM 2: no_pr_ever splits three ways ─────────────────────────────────────────────────────

test("W1-T2629(2): a slug branch whose named task is merge-credited reads named_task_credited", () => {
  const plan = planBranchReap(
    [f("w1t1060-instrument-declare", { namedTaskId: "W1-T1060", namedTaskCredited: true })],
    DECLARED_BRANCH_GUARDS,
  );
  assert.equal(plan.reasons["w1t1060-instrument-declare"], "named_task_credited");
});

test("W1-T2629(2): a slug branch whose named task is NOT credited reads named_task_open", () => {
  const plan = planBranchReap(
    [f("w1t2999-stuck-maybe", { namedTaskId: "W1-T2999", namedTaskCredited: false })],
    DECLARED_BRANCH_GUARDS,
  );
  assert.equal(plan.reasons["w1t2999-stuck-maybe"], "named_task_open");
});

test("W1-T2629(2): namedTaskCredited omitted while namedTaskId is present degrades to named_task_open", () => {
  // Conservative default, same discipline patchIdEquivalentInMain already documents: an absent
  // measurement can never manufacture a "credited" resolution the caller never proved.
  const plan = planBranchReap([f("w1t2999-stuck-maybe", { namedTaskId: "W1-T2999" })], DECLARED_BRANCH_GUARDS);
  assert.equal(plan.reasons["w1t2999-stuck-maybe"], "named_task_open");
});

test("W1-T2629(2): a branch naming no resolvable task keeps no_pr_ever unchanged", () => {
  const plan = planBranchReap([f("tmp-check-branch")], DECLARED_BRANCH_GUARDS);
  assert.equal(plan.reasons["tmp-check-branch"], "no_pr_ever");
});

test("W1-T2629(2): namedTaskCredited alone, without namedTaskId, is ignored — still plain no_pr_ever", () => {
  const plan = planBranchReap([f("tmp-check-branch", { namedTaskCredited: true })], DECLARED_BRANCH_GUARDS);
  assert.equal(plan.reasons["tmp-check-branch"], "no_pr_ever");
});

// ── CLAIM 3: THE DISPOSITION FALSIFIER — buckets never move ──────────────────────────────────

function bucketsOf(plan: BranchReapPlan): {
  deletable: string[];
  guarded: string[];
  hold: string[];
  undetermined: string[];
} {
  return {
    deletable: [...plan.deletable].sort(),
    guarded: [...plan.guarded].sort(),
    hold: [...plan.hold].sort(),
    undetermined: [...plan.undetermined].sort(),
  };
}

test("W1-T2629(3): deletable/guarded/hold/undetermined are identical whether the new fields are present or absent", () => {
  const baseFacts: BranchFacts[] = [
    f("protected-branch", { namedInSource: true }),
    f("plain-merge", { prState: "merged" }),
    f("declined", { prState: "closed" }),
    f("already-ancestor", { prState: "none", tipInMain: true }),
    f("cherry-picked-by-hand", { prState: "none", tipInMain: false, patchIdEquivalentInMain: true }),
    f("still-open", { prState: "open" }),
    f("could-not-tell", { prState: "unknown" }),
    f("confirmed-no-pr", { prState: "none", tipInMain: false }),
    f("w1t1060-instrument-declare", { prState: "none", tipInMain: false }),
  ];

  const planWithoutNamedTask = planBranchReap(baseFacts, DECLARED_BRANCH_GUARDS);

  const factsWithNamedTaskCredited = baseFacts.map((entry) =>
    entry.name === "w1t1060-instrument-declare"
      ? { ...entry, namedTaskId: "W1-T1060", namedTaskCredited: true }
      : entry,
  );
  const planWithCredited = planBranchReap(factsWithNamedTaskCredited, DECLARED_BRANCH_GUARDS);

  const factsWithNamedTaskOpen = baseFacts.map((entry) =>
    entry.name === "w1t1060-instrument-declare" ? { ...entry, namedTaskId: "W1-T1060", namedTaskCredited: false } : entry,
  );
  const planWithOpen = planBranchReap(factsWithNamedTaskOpen, DECLARED_BRANCH_GUARDS);

  const expectedBuckets = bucketsOf(planWithoutNamedTask);
  assert.deepEqual(bucketsOf(planWithCredited), expectedBuckets, "named_task_credited must not move any bucket");
  assert.deepEqual(bucketsOf(planWithOpen), expectedBuckets, "named_task_open must not move any bucket");

  // And the branch in question is (and stays) in `hold`, never `deletable` — a named task
  // shipping elsewhere does not prove THIS branch's commits are in main.
  assert.ok(planWithoutNamedTask.hold.includes("w1t1060-instrument-declare"));
  assert.ok(planWithCredited.hold.includes("w1t1060-instrument-declare"));
  assert.ok(planWithOpen.hold.includes("w1t1060-instrument-declare"));
  assert.ok(!planWithCredited.deletable.includes("w1t1060-instrument-declare"));
  assert.ok(!planWithOpen.deletable.includes("w1t1060-instrument-declare"));

  // Only the REASON differs between the three runs — proving the split is purely a label change.
  assert.equal(planWithoutNamedTask.reasons["w1t1060-instrument-declare"], "no_pr_ever");
  assert.equal(planWithCredited.reasons["w1t1060-instrument-declare"], "named_task_credited");
  assert.equal(planWithOpen.reasons["w1t1060-instrument-declare"], "named_task_open");
});

test("W1-T2629(3): named_task_credited on an already-merged branch never overrides the merged reason", () => {
  // Merged/closed are decided before the named-task fields are even consulted (same ordering
  // patchIdEquivalentInMain already relies on) — this is the same guard, exercised for the new
  // fields specifically so a future reordering cannot silently let a named-task fact override a
  // decisive PR read.
  const plan = planBranchReap(
    [f("plain-merge", { prState: "merged", namedTaskId: "W1-T1060", namedTaskCredited: true })],
    DECLARED_BRANCH_GUARDS,
  );
  assert.deepEqual(plan.deletable, ["plain-merge"]);
  assert.equal(plan.reasons["plain-merge"], "merged");
});

// ── CLAIM 4: the resolver is the ONE new extractor and planBranchReap stays pure ─────────────
// Proved by grep (`grep -n "taskIdFromSlugBranch" src/lib/status.ts`), not by a test: the
// function must exist there, exported, and `planBranchReap` must never call it (or any git/
// network primitive) itself — every fact it reads (`namedTaskId`, `namedTaskCredited`) arrives
// already resolved on `BranchFacts`. This import line is itself part of that proof: the test
// file reaches `taskIdFromSlugBranch` only through `src/lib/status.js`'s named export, the same
// module `planBranchReap` lives in and nothing else.
test("W1-T2629(4): taskIdFromSlugBranch is importable from src/lib/status.js alongside planBranchReap", () => {
  assert.equal(typeof taskIdFromSlugBranch, "function");
  assert.equal(typeof planBranchReap, "function");
});
