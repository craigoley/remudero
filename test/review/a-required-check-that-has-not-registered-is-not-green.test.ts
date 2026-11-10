import assert from "node:assert/strict";
import test from "node:test";

import { readChecksGreenReviewedAtHead } from "#src/cli/commands/review.js";
import { checksStateFromRollup } from "#src/lib/sweep.js";

const OWNER = "craigoley";
const REPO = "remudero";
const HEAD = "71fab712fb72e933784debaaed9f30f23230893c";
const REQUIRED = ["remudero-review", "ci-gate", "security-merge-policy"];

test("W1-T11606 criterion 1: every configured required context must register before checks are green", () => {
  const early = [
    { name: "remudero-review", state: "SUCCESS" },
    { name: "security-merge-policy", state: "SUCCESS" },
  ];
  assert.equal(checksStateFromRollup(early, REQUIRED), "pending");
  assert.equal(
    checksStateFromRollup([...early, { name: "ci-gate", state: "SUCCESS" }], REQUIRED),
    "green",
  );
});

test("W1-T11606 criterion 2: red registered gates win, review is excluded, and unread protection grades all reports", () => {
  assert.equal(
    checksStateFromRollup([
      { name: "security-merge-policy", state: "SUCCESS" },
      { name: "ci-gate", state: "FAILURE" },
    ], REQUIRED),
    "red",
  );
  assert.equal(
    checksStateFromRollup([{ name: "security-merge-policy", state: "SUCCESS" }], ["remudero-review", "security-merge-policy"]),
    "green",
    "remudero-review is not required of checksState when its own status is absent",
  );
  assert.equal(
    checksStateFromRollup([
      { name: "security-merge-policy", state: "SUCCESS" },
      { name: "other-reported-check", state: "PENDING" },
      { name: "remudero-review", state: "SUCCESS" },
    ], undefined),
    "pending",
    "an unread required list keeps the fail-closed every-reported-context reading",
  );
});

test("W1-T11606 criterion 3: the review lane refuses green while ci-gate has not registered", async () => {
  const readText = async (args: string[]) => {
    assert.equal(args[1], `repos/${OWNER}/${REPO}/branches/main/protection/required_status_checks`);
    return JSON.stringify({
      checks: [
        { context: "remudero-review" },
        { context: "ci-gate" },
        { context: "security-merge-policy" },
      ],
    });
  };
  const readJson = (args: string[]): unknown => {
    if (args[1] === `repos/${OWNER}/${REPO}/commits/${HEAD}/check-runs?per_page=100`)
      return { total_count: 0, check_runs: [] };
    if (args[1] === `repos/${OWNER}/${REPO}/commits/${HEAD}/status`)
      return {
        statuses: [
          { context: "remudero-review", state: "success" },
          { context: "security-merge-policy", state: "success" },
        ],
      };
    throw new Error(`unexpected JSON read: ${args.join(" ")}`);
  };

  assert.equal(
    await readChecksGreenReviewedAtHead(OWNER, REPO, HEAD, readJson, readText),
    false,
  );
});
