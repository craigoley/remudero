// W1-T3067 — the diff-based plan-only refusal existed and was SKIPPED. `ownsOwnRunBranch` suppressed
// it on the stated assumption that "a worker's own run-branch PR is an implementation by
// construction" — false: a lane dispatched on a task files an AMENDMENT from that same branch.
// MEASURED: #3195 (head run-W1-T2371-…, whole diff one shard file) and #3896 (head run-W1-T2648-…).
// The ledger arm cannot catch them either, so nothing did — and W1-T2794's rung closed #4461.

import assert from "node:assert/strict";
import test from "node:test";

import { isPlanOnlyChangeset } from "../src/lib/status.js";

/** The #3195 shape: a filing opened from the task's OWN run branch. */
const FILING_PATHS = ["plan/tasks.d/W1-T2371-the-risk-judge-cannot-pass-an-amendment.yaml"];
/** The #3614 shape: a filing-ish SUBJECT whose diff is real work. */
const DOCS_IMPL_PATHS = ["CLAUDE.md"];
/** An ordinary implementation. */
const SRC_PATHS = ["src/lib/risk-judge.ts", "test/risk-judge-plan-only-amendment.test.ts"];

test("W1-T3067 criterion 1: the #3195 shape IS a plan-only changeset, so the refusal has something to fire on", () => {
  // The predicate was never wrong; it was never consulted. This pins that the evidence is decisive.
  assert.equal(isPlanOnlyChangeset(FILING_PATHS), true);
});

test("W1-T3067 criterion 2 (falsifier): the #3614 shape is NOT plan-only — a docs implementation keeps its credit", () => {
  // THE ROW THAT STOPS AN OVERCORRECTION. Classifying by SUBJECT would have stripped this credit:
  // `docs: retire stale CLAUDE.md cap figures` IS W1-T2611's implementation.
  assert.equal(isPlanOnlyChangeset(DOCS_IMPL_PATHS), false);
  assert.equal(isPlanOnlyChangeset(SRC_PATHS), false);
  assert.equal(isPlanOnlyChangeset([...FILING_PATHS, ...SRC_PATHS]), false, "a mixed diff is not a filing");
});

test("W1-T3067 criterion 3 (falsifier): an EMPTY or unknown changeset is not a filing", () => {
  // Absence of evidence must never become a refusal: a transient read failure would otherwise
  // silently uncredit the plan.
  assert.equal(isPlanOnlyChangeset([]), false);
});

test("W1-T3067 criterion 4: the refusal is SUBTRACT-ONLY — no path input can create credit", () => {
  // Every arrangement of the new evidence, over a changeset that is not plan-only, leaves the
  // refusal false; the refusal can only ever remove a credit that would otherwise stand.
  for (const paths of [SRC_PATHS, DOCS_IMPL_PATHS, [], [...FILING_PATHS, "src/x.ts"]]) {
    assert.equal(isPlanOnlyChangeset(paths), false, `${JSON.stringify(paths)} must not read as a filing`);
  }
});

test("W1-T3067: a run-branch head is NOT evidence of an implementation", () => {
  // The assumption the removed shortcut rested on, stated as a test: the branch name and the diff
  // are independent, and only the diff answers the question. Both #3195 and #3896 carried a
  // task-shaped run branch AND a plan-only diff.
  const runBranchHeads = ["run-W1-T2371-1787887882921", "run-W1-T2648-1788508326964"];
  for (const head of runBranchHeads) {
    assert.match(head, /^run-W1-T\d+-\d+$/, "sanity: these ARE the branch shape the shortcut trusted");
  }
  assert.equal(isPlanOnlyChangeset(FILING_PATHS), true, "yet the diff on that branch is a filing");
});
