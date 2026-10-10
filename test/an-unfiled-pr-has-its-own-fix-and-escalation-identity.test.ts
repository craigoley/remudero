/**
 * W1-T5866 — AN UNFILED PR HAS ITS OWN FIX AND ESCALATION IDENTITY.
 *
 * `unfiled` is the branch-shape SENTINEL every `run-unfiled-<epochMs>` head recovers, never one PR's id. After
 * W1-T5839 a run-unfiled PR's REVIEW rows are keyed `PR-<n>`, but the fix lane (strikes, `fixRoundTally`, fix
 * claims), escalations and the sweep's review-admission dedup key still read `pr.taskId ?? PR-<n>`, so every
 * run-unfiled PR shared one `unfiled` strike budget and escalation. Every test drives PURE functions — no gateway.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  decideSweepArm,
  escalationTaskIdFor,
  fixHeadAcceptable,
  fixLedgerTaskIdFor,
  fixOwnershipIdFor,
  fixRoundTally,
  fixRungTaskFor,
  reviewOutcomeTaskIdFor,
} from "../src/lib/sweep.js";
import type { OpenPrView } from "../src/lib/sweep.js";
import type { Plan } from "../src/lib/plan.js";

const PLAN: Plan = { tasks: [], byId: new Map() };
const HEAD_A = "a".repeat(40);
const HEAD_B = "b".repeat(40);

function dispatchRow(taskId: string, headSha: string, strike: number): Record<string, unknown> {
  return { task_id: taskId, step: "fix.dispatch", strike, head_sha: headSha };
}

test("unit test: test/an-unfiled-pr-has-its-own-fix-and-escalation-identity.test.ts — two run-unfiled PRs escalate under their own PR-<n>", () => {
  assert.equal(escalationTaskIdFor({ taskId: "unfiled", prNumber: 9305 }), "PR-9305");
  assert.equal(escalationTaskIdFor({ taskId: "unfiled", prNumber: 9306 }), "PR-9306");
  assert.equal(escalationTaskIdFor({ prNumber: 9307 }), "PR-9307", "no id at all is still PR-<n>");
  assert.equal(escalationTaskIdFor({ taskId: "W1-T100", prNumber: 9308 }), "W1-T100", "a real task id is unchanged");
});

test("unit test: test/an-unfiled-pr-has-its-own-fix-and-escalation-identity.test.ts — two run-unfiled PRs keep separate strike counts", () => {
  const first = { taskId: "unfiled", prNumber: 9305 };
  const second = { taskId: "unfiled", prNumber: 9306 };
  // The fix worker writes its rows under the synthetic task's id: PR-9305 for the first PR only.
  const ledger = [
    dispatchRow(fixLedgerTaskIdFor(first)!, HEAD_A, 1),
    dispatchRow(fixLedgerTaskIdFor(first)!, HEAD_A, 2),
  ];
  assert.equal(fixLedgerTaskIdFor(first), "PR-9305");
  assert.equal(fixLedgerTaskIdFor(second), "PR-9306");
  assert.equal(fixRoundTally(ledger, fixLedgerTaskIdFor(first), HEAD_A).strikes, 2);
  assert.equal(fixRoundTally(ledger, fixLedgerTaskIdFor(second), HEAD_A).strikes, 0, "the second PR inherits none of the first's strikes");
  assert.equal(fixLedgerTaskIdFor({ prNumber: 1 }), undefined, "a PR with no id has no strike history to read");
});

test("unit test: test/an-unfiled-pr-has-its-own-fix-and-escalation-identity.test.ts — a PR with a real task id keeps its task-keyed strikes", () => {
  const pr = { taskId: "W1-T100", prNumber: 9308 };
  const ledger = [dispatchRow("W1-T100", HEAD_B, 1), dispatchRow("PR-9308", HEAD_B, 1)];
  assert.equal(fixLedgerTaskIdFor(pr), "W1-T100");
  assert.equal(fixRoundTally(ledger, fixLedgerTaskIdFor(pr), HEAD_B).strikes, 1);
});

test("unit test: test/an-unfiled-pr-has-its-own-fix-and-escalation-identity.test.ts — the fix rung's synthetic task for a run-unfiled PR is keyed PR-<n> and still owns its head", () => {
  const { task, synthetic } = fixRungTaskFor(PLAN, { prNumber: 9305, taskId: "unfiled" }, "", "run-unfiled-1790000000000");
  assert.equal(synthetic, true);
  assert.equal(task.id, "PR-9305", "the rows the fix worker writes name this PR, not the shared sentinel");
  assert.equal(
    fixHeadAcceptable("run-unfiled-1790000000000", fixOwnershipIdFor("unfiled", task.id), synthetic),
    true,
    "the run-unfiled head is still the rung's own branch",
  );
  assert.equal(fixHeadAcceptable("run-W1-T123-1790000000000", fixOwnershipIdFor("unfiled", task.id), synthetic), false);
  assert.equal(fixOwnershipIdFor("W1-T100", "W1-T100"), "W1-T100", "any other PR keeps the task's own id");
});

test("unit test: test/an-unfiled-pr-has-its-own-fix-and-escalation-identity.test.ts — a run-unfiled plan filing has the same admission review_key whether or not it is classified plan-only", () => {
  const digest = "d".repeat(64);
  const unclassified = reviewOutcomeTaskIdFor({ taskId: "unfiled", prNumber: 9249, reviewInputDigest: digest });
  const classifiedPlanOnly = reviewOutcomeTaskIdFor({ prNumber: 9249, reviewInputDigest: digest });
  assert.equal(unclassified, "PR-9249");
  assert.equal(classifiedPlanOnly, unclassified);
  assert.equal(reviewOutcomeTaskIdFor({ taskId: "W1-T100", prNumber: 9249, reviewInputDigest: digest }), "W1-T100");
  assert.equal(reviewOutcomeTaskIdFor({ taskId: "unfiled", prNumber: 9249 }), "unfiled", "a digest-less legacy caller is unchanged");
});

test("unit test: test/an-unfiled-pr-has-its-own-fix-and-escalation-identity.test.ts — the sweep arm reads a run-unfiled PR's own PR-<n> verdict", () => {
  const view = (taskId: string | undefined): OpenPrView => ({
    prNumber: 9305, prUrl: "https://github.com/craigoley/remudero/pull/9305", taskId, headSha: HEAD_A,
    reviewState: "success", checksState: "green",
  } as unknown as OpenPrView);
  const ledger = [{
    task_id: "PR-9305", step: "review.posted", verdict: "success", head_sha: HEAD_A,
    pr_url: "https://github.com/craigoley/remudero/pull/9305",
  }];
  assert.equal(
    JSON.stringify(decideSweepArm(view("unfiled"), ledger)),
    JSON.stringify(decideSweepArm(view(undefined), ledger)),
    "the arm decision does not flip with the sentinel",
  );
});
