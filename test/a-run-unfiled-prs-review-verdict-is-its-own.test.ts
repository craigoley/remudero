import assert from "node:assert/strict";
import { test } from "node:test";
import { armAutoMergeDetailed, type ArmDeps } from "../src/lib/arm-auto-merge.js";
import * as review from "../src/lib/review.js";
import { resolveReviewTaskId } from "../src/run-task.js";

// W1-T5839. Namespace import: this file still LOADS at the merge base, where `reviewKeyForTaskId` does not exist,
// and its tests fail there as tests.

const HEAD = "5839aaaabbbbccccddddeeeeffff000011112222";
const URL_A = "https://github.com/acme/remudero/pull/9249";
const URL_B = "https://github.com/acme/remudero/pull/9259";

function posted(taskId: string, prUrl: string | undefined, state: "success" | "failure", head = HEAD): Record<string, unknown> {
  return { step: "review.posted", task_id: taskId, head_sha: head, state, capped: false, plan_only: false, ...(prUrl ? { pr_url: prUrl } : {}) };
}

function keyFor(body: string, head: string, planOnly: boolean, prNumber: number): string {
  const keyFn = (review as unknown as { reviewKeyForTaskId: (t: string | undefined, n: number) => string }).reviewKeyForTaskId;
  return keyFn(resolveReviewTaskId(body, head, planOnly), prNumber);
}

test("a run-unfiled PR's review key is PR-<n> whether or not it is classified a plan-only filing", () => {
  assert.equal(keyFor("", "run-unfiled-1791200000000", false, 9249), "PR-9249");
  assert.equal(keyFor("", "run-unfiled-1791200000000", true, 9249), "PR-9249");
});

test("a trailer or run-branch task id keeps its own review key", () => {
  assert.equal(keyFor("Remudero-Task: W1-T5839", "run-unfiled-1", false, 9249), "W1-T5839");
  assert.equal(keyFor("", "run-W1-T5839-1791207026374", false, 9249), "W1-T5839");
});

test("priorReviewVerdictFromLedger given a PR url ignores another PR's newer row under the same key", () => {
  const lines = [posted("unfiled", URL_A, "success"), posted("unfiled", URL_B, "failure")];
  assert.equal(review.priorReviewVerdictFromLedger(lines, "unfiled", URL_A)?.state, "success");
  assert.equal(review.priorReviewVerdictFromLedger(lines, "unfiled", URL_B)?.state, "failure");
  assert.equal(review.priorReviewVerdictFromLedger(lines, "unfiled")?.state, "failure");
});

test("a legacy review row with no pr_url still counts for a scoped read", () => {
  const lines = [posted("unfiled", undefined, "success")];
  assert.equal(review.priorReviewVerdictFromLedger(lines, "unfiled", URL_A)?.state, "success");
});

test("the arm gate reads a run-unfiled PR's verdict under its own PR key, not another PR's row", () => {
  const lines = [posted("PR-9249", URL_A, "success"), posted("PR-9259", URL_B, "failure"), posted("unfiled", URL_B, "failure")];
  const armed: string[] = [];
  const deps: ArmDeps = {
    headSha: () => HEAD,
    ledgerLines: () => lines,
    armAuto: (prUrl) => void armed.push(prUrl),
    mergeDirect: () => {
      throw new Error("never merges directly");
    },
    disableAuto: () => {},
    say: () => {},
  };
  assert.equal(armAutoMergeDetailed(URL_A, "unfiled", deps).outcome, "armed");
  assert.deepEqual(armed, [URL_A]);
  assert.equal(armAutoMergeDetailed(URL_B, "unfiled", deps).outcome, "ledger-refused");
});
