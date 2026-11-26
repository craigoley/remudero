/**
 * W1-T14939: the reviewer checkout's integrity status read ran at Node's 1 MiB execFileSync default, so a dirty tree
 * whose `git status --porcelain=v1 -uall` passed 1 MiB threw ENOBUFS and was refused as "unreadable". The read now
 * has no output bound: a large dirty checkout is refused as "dirty", and nothing is trimmed.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { assertReviewerSnapshotIntegrity, ReviewerSnapshotError } from "#src/cli/commands/review.js";
import { gitRepo } from "#test/helpers/git-repo.js";

const HOST = { GIT_UNTRACKED_FILES_ALL: "--untracked-files=all" };
const ONE_MIB = 1024 * 1024;

function withCheckout(fn: (dir: string, head: string) => void): void {
  const repo = gitRepo({ kind: "w1-t14939" });
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

test("W1-T14939 criterion 1: a checkout whose status output exceeds 1 MiB is refused as dirty", () => {
  withCheckout((dir, head) => {
    // 6,000 untracked files with ~200-character paths: each porcelain line is "?? <path>\n".
    const stem = "u".repeat(180);
    let bytes = 0;
    for (let d = 0; d < 60; d++) {
      const sub = join(dir, `d${String(d).padStart(3, "0")}`);
      mkdirSync(sub);
      for (let f = 0; f < 100; f++) {
        const name = `${stem}-${String(f).padStart(4, "0")}.txt`;
        writeFileSync(join(sub, name), "");
        bytes += `?? d000/${name}\n`.length;
      }
    }
    assert.ok(bytes > ONE_MIB, `the fixture's status output exceeds 1 MiB (${bytes} bytes)`);
    const e = refusal(dir, head);
    assert.deepEqual([e.phase, e.reason, e.message], ["integrity", "dirty", "semantic reviewer changed the disposable checkout"]);
  });
});

test("W1-T14939 criterion 2: a clean exact checkout passes and a moved HEAD is head-mismatch", () => {
  withCheckout((dir, head) => {
    assert.doesNotThrow(() => assertReviewerSnapshotIntegrity(HOST, dir, head));
  });
  withCheckout((dir) => {
    const e = refusal(dir, "f".repeat(40));
    assert.deepEqual([e.phase, e.reason, e.message], ["integrity", "head-mismatch", "semantic reviewer changed the checkout HEAD"]);
  });
});
