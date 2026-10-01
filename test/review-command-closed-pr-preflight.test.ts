import assert from "node:assert/strict";
import test from "node:test";
import { reviewCommand } from "../src/run-task.js";

test("review command declines a PR closed after sweep discovery before materializing its worktree", async () => {
  let read = 0;
  const code = await reviewCommand("8303", ["--repo", "acme/remudero"], {
    resolveOwnerRepo: () => ({ owner: "acme", repo: "remudero" }),
    fetchView: () => { read++; return { state: "closed", number: 8303 }; },
    loadConfig: () => { throw new Error("closed PR must not load the review workspace"); },
    fetchHead: () => { throw new Error("closed PR must not fetch its old head"); },
  });
  assert.equal(code, 2);
  assert.equal(read, 1, "the existing REST view supplies the lifecycle fact");
});

test("review command continues to the review workspace for an open PR", async () => {
  let loaded = false;
  await assert.rejects(
    reviewCommand("8303", ["--repo", "acme/remudero"], {
      resolveOwnerRepo: () => ({ owner: "acme", repo: "remudero" }),
      fetchView: () => ({ state: "open", number: 8303, html_url: "https://github.com/acme/remudero/pull/8303", updated_at: "2026-10-01T00:00:00Z", head: { ref: "topic", sha: "abc123" }, body: "" }),
      loadConfig: () => { loaded = true; throw new Error("open PR reached review workspace"); },
    }),
    /open PR reached review workspace/,
  );
  assert.equal(loaded, true);
});
