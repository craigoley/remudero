import { strict as assert } from "node:assert";
import { test } from "node:test";
import * as sweep from "../src/lib/sweep.js";
import type { ConflictFileDiff, OpenPrView } from "../src/lib/sweep.js";

/**
 * #10555, 2026-10-09: a run-unfiled PR sat `mergeable_state: dirty` from 05:32Z until an operator
 * merged main by hand. Its review had failed, and the review-failed rows ranked ABOVE the dirty
 * rows in DISPOSITION_RULES, so every pass sent it to a review-fix round. A review fix cannot
 * clear a merge conflict, and a conflicting PR registers zero check runs, so nothing could move.
 * CONFLICT-FIRST: a dirty merge state is ranked above review-failed and ci-red, and where repair
 * is not allowed the PR escalates naming the conflict, never a review or ci round.
 */

const NOW = Date.parse("2026-10-09T05:40:00.000Z");
const EVIDENCE: ConflictFileDiff[] = [{ path: "src/lib/sweep.ts", oursDeleted: 0, theirsDeleted: 0 }];

function dirtyPr(over: Partial<OpenPrView> = {}): OpenPrView {
  return {
    prNumber: 10555,
    prUrl: "https://github.com/craigoley/remudero/pull/10555",
    taskId: "unfiled",
    headRefName: "run-unfiled-1791500000000",
    reviewState: "failure",
    checksState: "green",
    unmetCriteria: ["the new test is not discriminating"],
    priorStrikes: 0,
    strikeHistory: [],
    lastActivityAt: "2026-10-09T05:32:00.000Z",
    headSha: "c0ffee10555",
    autoMergeArmed: false,
    isDependabot: false,
    mergeState: "dirty",
    mergeConflict: { files: EVIDENCE, oursLog: "abc1234 ours", theirsLog: "def5678 theirs" },
    ...over,
  } as OpenPrView;
}

test("conflict-first: a dirty PR whose review failed is dispositioned conflicted, never a review-fix round", () => {
  const d = sweep.deriveDisposition(dirtyPr(), sweep.DEFAULT_SWEEP_POLICY, NOW);
  assert.equal(d.disposition, "conflicted", `got ${d.disposition}: ${d.reason}`);
});

test("conflict-first: a dirty PR whose checks are red is dispositioned conflicted, never a ci-fix round", () => {
  const d = sweep.deriveDisposition(dirtyPr({ reviewState: "success", unmetCriteria: [], checksState: "red" }), sweep.DEFAULT_SWEEP_POLICY, NOW);
  assert.equal(d.disposition, "conflicted", `got ${d.disposition}: ${d.reason}`);
});

test("conflict-first: a dirty review-failed PR that cannot be repaired escalates naming the conflict, not the review", () => {
  const off = { ...sweep.DEFAULT_SWEEP_POLICY, mergeConflictAdmissionEnabled: false };
  const cases: Array<[string, OpenPrView, typeof off]> = [
    ["admission off", dirtyPr(), off],
    ["no evidence", dirtyPr({ mergeConflict: undefined }), sweep.DEFAULT_SWEEP_POLICY],
    ["foreign head", dirtyPr({ headRefName: "feature/contributor-change" }), sweep.DEFAULT_SWEEP_POLICY],
  ];
  for (const [label, pr, policy] of cases) {
    const d = sweep.deriveDisposition(pr, policy, NOW);
    assert.notEqual(d.disposition, "blocked-fixable", `${label}: a review-fix round cannot clear a conflict`);
    assert.match(d.reason, /merge conflict/i, `${label}: the escalation names the conflict — got ${d.disposition}: ${d.reason}`);
  }
});
