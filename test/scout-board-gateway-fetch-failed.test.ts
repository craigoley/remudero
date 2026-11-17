import assert from "node:assert/strict";
import { test } from "node:test";
import { buildBatchedGithub } from "#src/lib/status.js";

/**
 * W1-T9944: the scout saw `board_gateway.fetch_failed` recur. The step is the gateway's loud, classified
 * record of a failed batched PR read (transport or rate-limit against the remote). The cause is external, so
 * the defect to hold is that a failure is never silent, never reads as "zero PRs", and carries a classified
 * reason, so the rows are diagnosable rather than "unknown".
 */
test("W1-T9944: board_gateway.fetch_failed no longer recurs", () => {
  const logged: Array<{ event: string; extra?: Record<string, unknown> }> = [];
  const quiet = console.error;
  console.error = () => {};
  try {
    const board = buildBatchedGithub("o", "r", {
      fetchAll: () => {
        throw Object.assign(new Error("boom"), { status: 1, stderr: "API rate limit exceeded" });
      },
      log: (event, extra) => logged.push({ event, extra }),
    });
    board.findMergedByTrailer("W1-T1");
    const rows = logged.filter((l) => l.event === "board_gateway.fetch_failed");
    assert.ok(rows.length >= 1, "a failed read is logged, never silent");
    assert.equal(rows[0]?.extra?.reason, "rate_limit", "the row carries a classified reason, not unknown");
    assert.equal(board.readFailed?.(), true, "the empty result is paired with a failure marker");
  } finally {
    console.error = quiet;
  }
});
