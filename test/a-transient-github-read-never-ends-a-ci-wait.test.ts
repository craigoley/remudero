import assert from "node:assert/strict";
import { test } from "node:test";
import { isGhReadFailure, retryPollRead } from "../src/lib/poll-read-retry.js";
import { ciGateState, pollToGate, waitForCiGreen } from "../src/run-task.js";

// MEASURED 2026-09-28..30: 14 build runs ended "github-read-failed" on ONE unreadable response or failed
// `gh api .../check-runs` call while waiting on CI for a PR that was already open — every one of those PRs
// later merged through the sweep. A transient GitHub read is re-asked; a read that keeps failing still throws.

const PR_URL = "https://github.com/craigoley/remudero/pull/1";

function flaky(failures: number, message: string) {
  let failed = 0;
  let polls = 0;
  return {
    readJson: async (args: string[]) => {
      const request = args.join(" ");
      if (request.includes("/check-runs") && failed < failures) {
        failed++;
        throw new Error(message);
      }
      if (request.includes("/pulls/1")) {
        polls++;
        return { number: 1, state: "open", merged: false, merged_at: null, head: { sha: "deadbeef" } };
      }
      if (request.includes("/check-runs")) {
        return { check_runs: [{ name: "ci", status: "completed", conclusion: "success" }, { name: "ci-gate", status: "completed", conclusion: "success" }] };
      }
      if (request.includes("/status")) return { statuses: [] };
      throw new Error(`unexpected REST request: ${request}`);
    },
    sleep: async () => {},
    requiredContexts: () => ["ci-gate"],
    failedCount: () => failed,
    pollCount: () => polls,
  };
}

test("an unreadable GitHub response during the CI wait is re-asked, not a run error", async () => {
  const deps = flaky(2, "gh api response body was unreadable");
  const steps: string[] = [];
  const outcome = await waitForCiGreen(PR_URL, (step) => steps.push(step), 0, deps as never);
  assert.equal(ciGateState(outcome), "green");
  assert.equal(deps.failedCount(), 2, "both transient failures were absorbed");
  assert.equal(steps.filter((s) => s === "poll.read_retry").length, 2, "each retry is recorded");
});

test("a failed gh api check-runs call during the PR gate poll is re-asked", async () => {
  const deps = flaky(1, "Command failed: gh api repos/craigoley/remudero/commits/deadbeef/check-runs?per_page=100\n");
  const outcome = await pollToGate(PR_URL, () => {}, 0, deps as never);
  assert.equal(deps.failedCount(), 1);
  assert.notEqual(outcome.reason, undefined);
});

test("a GitHub read that keeps failing still ends the CI wait with its own error", async () => {
  const deps = flaky(Number.POSITIVE_INFINITY, "gh api response body was unreadable");
  await assert.rejects(waitForCiGreen(PR_URL, () => {}, 0, deps as never), /response body was unreadable/);
});

test("a non-GitHub error during the CI wait is never retried", async () => {
  const deps = flaky(1, "TypeError: cannot read properties of undefined");
  await assert.rejects(waitForCiGreen(PR_URL, () => {}, 0, deps as never), /cannot read properties/);
  assert.equal(deps.failedCount(), 1);
});

test("the retry helper waits on its own timer and reads a thrown non-Error as its text", async () => {
  let calls = 0;
  const value = await retryPollRead(async () => {
    calls++;
    if (calls === 1) throw "gh api response body was unreadable";
    return "read";
  }, { waitsMs: [0] });
  assert.equal(value, "read");
  assert.equal(isGhReadFailure("Command failed: gh api repos/o/r/pulls/1"), true);
  assert.equal(isGhReadFailure(new Error("ENOENT")), false);
});
