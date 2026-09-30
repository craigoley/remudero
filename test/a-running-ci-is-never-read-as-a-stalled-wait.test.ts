import assert from "node:assert/strict";
import { test } from "node:test";
import { ciGateState, waitForCiGreen } from "../src/run-task.js";

// MEASURED 2026-09-30: 7 build runs ended "blocked_ci: ci timeout before review; pending checks: none (0 total)"
// although CI had started within seconds with dozens of checks. The wait reads only the REQUIRED contexts
// (remudero-review, ci-gate), and ci-gate registers only after the CI matrix finishes — so five polls of an
// empty required view read as a stall while the matrix was still running.

const PR_URL = "https://github.com/craigoley/remudero/pull/1";

function scripted(pollsBeforeGate: number) {
  let polls = 0;
  return {
    readJson: async (args: string[]) => {
      const request = args.join(" ");
      if (request.includes("/pulls/1")) {
        polls++;
        return { number: 1, state: "open", merged: false, merged_at: null, head: { sha: "deadbeef" } };
      }
      if (request.includes("/check-runs")) {
        const runs = [{ name: "ci", status: polls <= pollsBeforeGate ? "in_progress" : "completed", conclusion: polls <= pollsBeforeGate ? null : "success" }];
        if (polls > pollsBeforeGate) runs.push({ name: "ci-gate", status: "completed", conclusion: "success" });
        return { check_runs: runs };
      }
      if (request.includes("/status")) return { statuses: [] };
      throw new Error(`unexpected REST request: ${request}`);
    },
    sleep: async () => {},
    requiredContexts: () => ["remudero-review", "ci-gate"],
  };
}

test("a CI matrix still running before the required gate registers is waited on, not timed out", async () => {
  const outcome = await waitForCiGreen(PR_URL, () => {}, 0, scripted(7) as never);
  assert.equal(ciGateState(outcome), "green");
});

test("a quiescent rollup with the required gate never registering still stalls", async () => {
  const outcome = await waitForCiGreen(PR_URL, () => {}, 0, {
    readJson: async (args: string[]) => {
      const request = args.join(" ");
      if (request.includes("/pulls/1")) return { number: 1, state: "open", merged: false, merged_at: null, head: { sha: "deadbeef" } };
      if (request.includes("/check-runs")) return { check_runs: [{ name: "ci", status: "completed", conclusion: "success" }] };
      if (request.includes("/status")) return { statuses: [] };
      throw new Error(`unexpected REST request: ${request}`);
    },
    sleep: async () => {},
    requiredContexts: () => ["remudero-review", "ci-gate"],
  } as never);
  assert.equal(ciGateState(outcome), "timeout");
});
