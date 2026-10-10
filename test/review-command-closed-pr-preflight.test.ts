import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { Config } from "../src/lib/config.js";
import { reviewCommand } from "../src/run-task.js";

test("review command declines a PR closed after sweep discovery before materializing its worktree", async () => {
  let read = 0;
  // The config is read only to ledger the decline; the head fetch and worktree stay unreached.
  const root = mkdtempSync(join(tmpdir(), "rmd-closed-preflight-"));
  try {
    const code = await reviewCommand("8303", ["--repo", "acme/remudero"], {
      resolveOwnerRepo: () => ({ owner: "acme", repo: "remudero" }),
      fetchView: () => { read++; return { state: "closed", number: 8303 }; },
      loadConfig: () => ({ root, claudeBin: "/bin/true" }) as Config,
      fetchHead: () => { throw new Error("closed PR must not fetch its old head"); },
      materialize: () => { throw new Error("closed PR must not materialize a worktree"); },
    });
    assert.equal(code, 2);
    assert.equal(read, 1, "the existing REST view supplies the lifecycle fact");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("review command continues to the review workspace for an open PR", async () => {
  let loaded = false;
  await assert.rejects(
    reviewCommand("8303", ["--repo", "acme/remudero"], {
      resolveOwnerRepo: () => ({ owner: "acme", repo: "remudero" }),
      fetchView: () => ({ state: "open", number: 8303, html_url: "https://github.com/acme/remudero/pull/8303", updated_at: "2026-10-01T00:00:00Z", head: { ref: "topic", sha: "abc123" }, body: "" }), // expiring-fixture: exempt -- the closed-PR preflight reads state, not age; 2/2 pass with Date.now shifted +8d and +30d and with this stamp aged to 2026-07-01
      loadConfig: () => { loaded = true; throw new Error("open PR reached review workspace"); },
    }),
    /open PR reached review workspace/,
  );
  assert.equal(loaded, true);
});
