// W1-T3694 — W1-T2855 correctly refuses to merge on UNREADABLE or CONFLICTING facts. This narrows
// only the BEHIND case: a PR GitHub considers mergeable, whose base branch does not require
// branches to be up to date, does not need its head rewritten to merge.
//
// THE COST OF THE UNNEEDED UPDATE IS NOT JUST A CI CYCLE. The arm runs BEFORE remudero-review is
// posted, so an update strands the review on the sha it just replaced and the PR falls back to
// "remudero-review is not success" -- measured as the single largest automerge refusal class on
// this repo (1,191 of 1,556). An update the merge never needed is a self-inflicted share of it.
import assert from "node:assert/strict";
import test from "node:test";
import { attemptArm, type FixRebaseMergeFacts } from "../src/run-task.js";

const PR = "https://github.com/craigoley/remudero/pull/5779";
const HEAD = "8c2cd65e7f1069262ad17bb8d50ccb39a8c365ba";
const CLEAN = "Pull request is in clean status";

const throwing = (msg: string) => () => {
  throw Object.assign(new Error("boom"), { stderr: msg });
};

type AttemptDeps = Parameters<typeof attemptArm>[1];

function harness(over: Record<string, unknown> = {}) {
  const calls: string[] = [];
  const base = {
    headSha: () => HEAD,
    armAuto: throwing(CLEAN),
    mergeDirect: () => void calls.push("mergeDirect"),
    readMergeFacts: () => ({ mergeable: "MERGEABLE", behindBy: 0 } as FixRebaseMergeFacts),
    updateBranch: () => {
      calls.push("updateBranch");
      return { ok: true };
    },
    say: () => {},
  };
  return { deps: { ...base, ...over } as unknown as AttemptDeps, calls };
}

test("W1-T3694: a BEHIND but mergeable PR merges as-is when GitHub does not report it as behind-blocked", () => {
  const { deps, calls } = harness({
    // `clean` is what GitHub returns for a behind PR whose base does NOT require up-to-date branches.
    readMergeFacts: () => ({ mergeable: "MERGEABLE", behindBy: 7, mergeableState: "clean" }),
  });

  const result = attemptArm(PR, deps, HEAD);

  assert.deepEqual(calls, ["mergeDirect"], "the merge proceeds; the head is NOT rewritten");
  assert.doesNotMatch(String(result.outcome), /updated/);
});

test("W1-T3694: a PR GitHub reports as `behind` IS still updated — a strict base branch is unaffected", () => {
  const { deps, calls } = harness({
    readMergeFacts: () => ({ mergeable: "MERGEABLE", behindBy: 3, mergeableState: "behind" }),
  });

  const result = attemptArm(PR, deps, HEAD);

  assert.equal(String(result.outcome), "direct-merge-updated");
  assert.deepEqual(calls, ["updateBranch"], "when being behind really blocks the merge, the update still happens");
});

test("W1-T3694: an UNREADABLE mergeable_state keeps the old behaviour — unknown never SKIPS an update", () => {
  const { deps, calls } = harness({
    readMergeFacts: () => ({ mergeable: "MERGEABLE", behindBy: 2 }), // no mergeableState at all
  });

  const result = attemptArm(PR, deps, HEAD);

  assert.equal(String(result.outcome), "direct-merge-updated");
  assert.deepEqual(calls, ["updateBranch"], "an absent state must fail toward the pre-existing, safer path");
});

test("W1-T3694: `blocked` (a missing required check) is not behind-blocked, so the head is left alone", () => {
  // The merge may still be refused downstream for the missing check -- that is GitHub's call, not
  // a reason to rewrite the head and strand the review that would have satisfied it.
  const { deps, calls } = harness({
    readMergeFacts: () => ({ mergeable: "MERGEABLE", behindBy: 5, mergeableState: "blocked" }),
  });

  attemptArm(PR, deps, HEAD);

  assert.ok(!calls.includes("updateBranch"), "a blocked-but-not-behind PR must not have its head rewritten");
});

test("W1-T3694: a CONFLICTING PR is still refused outright, never updated or merged", () => {
  const { deps, calls } = harness({
    readMergeFacts: () => ({ mergeable: "CONFLICTING", behindBy: 1, mergeableState: "dirty" }),
  });

  const result = attemptArm(PR, deps, HEAD);

  assert.equal(String(result.outcome), "direct-merge-preflight-refused");
  assert.deepEqual(calls, [], "W1-T2855's conflict refusal is untouched by this change");
});
