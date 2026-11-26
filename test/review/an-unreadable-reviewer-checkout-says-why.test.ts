/**
 * W1-T14938: #20913 lost four semantic reviews to "semantic reviewer checkout integrity is unreadable", and the row
 * dropped the git error, so the cause could not be read from the ledger. The integrity check now runs each git read
 * alone, and the row names the failing subcommand, its error and whether the checkout path still exists. The
 * refusal itself (phase, reason, message) is unchanged.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { gitRepo } from "#test/helpers/git-repo.js";
import {
  assertReviewerSnapshotIntegrity,
  ReviewerSnapshotError,
  reviewerSnapshotErrorRow,
} from "#src/cli/commands/review.js";

const HOST = { GIT_UNTRACKED_FILES_ALL: "--untracked-files=all" };

/** A one-commit checkout with the fixture's own git identity (CI has none). */
function withCheckout(fn: (dir: string, head: string) => void): void {
  const repo = gitRepo({ kind: "w1-t14938" });
  try {
    fn(repo.dir, repo.git("rev-parse", "HEAD"));
  } finally {
    repo.cleanup();
  }
}

function refusal(dir: string, head: string): ReviewerSnapshotError {
  try {
    assertReviewerSnapshotIntegrity(HOST, dir, head);
  } catch (e) {
    assert.ok(e instanceof ReviewerSnapshotError, `a ReviewerSnapshotError, got ${String(e)}`);
    return e;
  }
  assert.fail("the integrity check accepted the checkout");
}

test("W1-T14938 criterion 1: an unreadable reviewer checkout row names the git command, its error and whether the path exists", () => {
  // rev-parse fails: HEAD holds garbage.
  withCheckout((dir, head) => {
    writeFileSync(join(dir, ".git", "HEAD"), "not a ref\n");
    const row = reviewerSnapshotErrorRow(refusal(dir, head));
    assert.equal(row.git_command, "rev-parse");
    assert.match(String(row.git_error), /\S/);
    assert.equal(row.checkout_exists, true);
  });
  // rev-parse succeeds and status fails: the index is corrupt.
  withCheckout((dir, head) => {
    writeFileSync(join(dir, ".git", "index"), "corrupt index\n");
    const row = reviewerSnapshotErrorRow(refusal(dir, head));
    assert.equal(row.git_command, "status");
    assert.match(String(row.git_error), /index/i);
    assert.equal(row.checkout_exists, true);
  });
  // The checkout path is gone.
  withCheckout((dir, head) => {
    rmSync(dir, { recursive: true, force: true });
    const row = reviewerSnapshotErrorRow(refusal(dir, head));
    assert.equal(row.git_command, "rev-parse");
    assert.equal(row.checkout_exists, false);
  });
});

test("W1-T14938 criterion 2: an unreadable checkout is still refused as before", () => {
  withCheckout((dir, head) => {
    writeFileSync(join(dir, ".git", "HEAD"), "not a ref\n");
    const e = refusal(dir, head);
    assert.equal(e.phase, "integrity");
    assert.equal(e.reason, "unreadable");
    assert.equal(e.message, "semantic reviewer checkout integrity is unreadable");
    const row = reviewerSnapshotErrorRow(e);
    assert.equal(row.reason, "unreadable");
    assert.equal(row.error, "semantic reviewer checkout integrity is unreadable");
  });
  withCheckout((dir) => {
    const e = refusal(dir, "f".repeat(40));
    assert.deepEqual([e.phase, e.reason, e.message], ["integrity", "head-mismatch", "semantic reviewer changed the checkout HEAD"]);
    assert.deepEqual(reviewerSnapshotErrorRow(e), { reason: "head-mismatch", error: "semantic reviewer changed the checkout HEAD" });
  });
  withCheckout((dir, head) => {
    writeFileSync(join(dir, "stray.txt"), "x\n");
    const e = refusal(dir, head);
    assert.deepEqual([e.phase, e.reason, e.message], ["integrity", "dirty", "semantic reviewer changed the disposable checkout"]);
    assert.deepEqual(reviewerSnapshotErrorRow(e), { reason: "dirty", error: "semantic reviewer changed the disposable checkout" });
  });
  withCheckout((dir, head) => {
    assert.doesNotThrow(() => assertReviewerSnapshotIntegrity(HOST, dir, head), "an exact, clean checkout still passes");
  });
});
