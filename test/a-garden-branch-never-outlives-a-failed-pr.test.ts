/**
 * 2026-09-29: origin carried 103 `plan-garden-*` heads and not one had a pull request. Every one was a
 * test run: the plan gardener ran over the real checkout, `gardenCheckout.land` PUSHED, and only then
 * did the live-write guard refuse the PR. A branch pushed for a PR that never opened is now never left
 * behind: both guards run before the push, and a PR create that throws retracts the branch.
 */
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { fixedClock } from "../src/lib/clock.js";
import { LiveWriteBlockedError, withLiveWritesAllowed } from "../src/lib/live-write-guard.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";
import { gardenCheckout, retractGardenBranch } from "../src/run-task.js";
import { gitRepo } from "./helpers/git-repo.js";

function gardenFixture() {
  const seed = gitRepo({ kind: "garden-leak-seed" });
  writeFileSync(join(seed.dir, "README.md"), "seed\n");
  seed.git("add", "README.md");
  seed.git("commit", "-q", "-m", "seed");
  const origin = gitRepo({ bare: true, kind: "garden-leak-origin" });
  seed.addRemote("origin", origin.dir);
  seed.git("push", "-q", "origin", "HEAD:main");
  const clone = gitRepo({ cloneFrom: origin.dir, kind: "garden-leak-clone" });
  clone.git("config", "user.email", "g@example.invalid");
  clone.git("config", "user.name", "g");
  const heads = () => origin.git("for-each-ref", "--format=%(refname:short)", "refs/heads").split("\n").filter(Boolean).sort();
  const cleanup = () => {
    origin.cleanup();
    seed.cleanup();
    clone.cleanup();
  };
  return { clone, heads, cleanup };
}

function checkout(cloneDir: string, fetcher: (args: string[]) => unknown, log: (step: string, extra?: Record<string, unknown>) => void = () => {}) {
  const ws = gardenCheckout({
    name: "plan",
    repoDir: cloneDir,
    worktreesRoot: mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}garden-leak-wt-`)),
    owner: "acme",
    repo: "remudero",
    log,
    clock: fixedClock(1790000000002),
    fetcher,
  });
  writeFileSync(join(ws.root, "change.txt"), "x\n");
  return ws;
}

test("a garden land refused by the live-write guard pushes no branch to origin", () => {
  const f = gardenFixture();
  const ws = checkout(f.clone.dir, () => ({ html_url: "https://github.com/acme/remudero/pull/1", number: 1 }));
  try {
    assert.throws(() => ws.land({ paths: ["change.txt"], title: "chore: t", body: "b" }), LiveWriteBlockedError);
    assert.deepEqual(f.heads(), ["main"], "the refused land left no garden branch on origin");
  } finally {
    ws.dispose();
    f.cleanup();
  }
});

test("a garden PR create that throws retracts its pushed branch", () => {
  const f = gardenFixture();
  const steps: string[] = [];
  const ws = checkout(
    f.clone.dir,
    (args) => {
      if (args.includes("POST") || args.some((a) => a === "--method")) throw new Error("HTTP 403: secondary rate limit");
      return [];
    },
    (step) => steps.push(step),
  );
  try {
    assert.throws(() => withLiveWritesAllowed(() => ws.land({ paths: ["change.txt"], title: "chore: t", body: "b" })), /secondary rate limit/);
    assert.deepEqual(f.heads(), ["main"], "the branch pushed for the failed PR is gone");
    assert.ok(steps.includes("plan.garden_branch_retracted"), `ledgered the retraction: ${steps.join(",")}`);
  } finally {
    ws.dispose();
    f.cleanup();
  }
});

test("a garden branch whose PR did open server-side is kept", () => {
  const f = gardenFixture();
  const ws = checkout(f.clone.dir, (args) => {
    if (args.includes("POST") || args.some((a) => a === "--method")) throw new Error("HTTP 502");
    return [{ html_url: "https://github.com/acme/remudero/pull/9", number: 9 }];
  });
  try {
    assert.throws(() => withLiveWritesAllowed(() => ws.land({ paths: ["change.txt"], title: "chore: t", body: "b" })), /HTTP 502/);
    assert.deepEqual(f.heads(), ["main", "plan-garden-1790000000002"], "a branch a PR sits on is never deleted");
  } finally {
    ws.dispose();
    f.cleanup();
  }
});

test("a garden branch is kept when its PR probe or its delete fails", () => {
  const log = () => {};
  const base = { branch: "plan-garden-1", name: "plan", owner: "acme", repo: "remudero", log };
  let deletes = 0;
  const git = () => {
    deletes++;
    return "";
  };
  assert.equal(retractGardenBranch({ ...base, git, fetcher: () => { throw new Error("Bad credentials"); } }), "kept_unreadable");
  assert.equal(deletes, 0, "an unreadable probe never deletes");
  const failingGit = () => {
    throw new Error("remote rejected");
  };
  assert.equal(retractGardenBranch({ ...base, git: failingGit, fetcher: () => [] }), "kept_delete_failed");
  assert.equal(retractGardenBranch({ ...base, git, fetcher: () => [] }), "deleted");
  assert.equal(deletes, 1);
});
