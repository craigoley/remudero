import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { reapStaleWorktrees } from "../src/lib/worker.js";
import { gitRepo } from "./helpers/git-repo.js";

function fixture() {
  const { dir, git } = gitRepo({ kind: "reap-initializing" });
  const root = realpathSync(dir);
  const repo = root;
  const worktrees = join(root, "worktrees");
  mkdirSync(worktrees);
  const add = (name: string, reason?: string) => {
    const path = join(worktrees, name);
    git("worktree", "add", "--detach", path);
    const admin = readFileSync(join(path, ".git"), "utf8").trim().slice("gitdir: ".length);
    if (reason !== undefined) writeFileSync(join(admin, "locked"), reason);
    return { name, path, admin };
  };
  const reap = (dryRun = false) => reapStaleWorktrees(worktrees, { maxAgeMs: 0, dryRun });
  return { root, repo, git, add, reap };
}

test("an initializing lock is removed through git with its admin record", () => {
  const f = fixture();
  try {
    const wt = f.add("machine-judge-garden-interrupted", "initializing\n");
    writeFileSync(join(wt.admin, "index.lock"), "");
    assert.match(f.git("worktree", "list", "--porcelain"), /locked initializing/);
    assert.throws(() => f.git("worktree", "remove", "--force", wt.path), /locked working tree/);

    const summary = f.reap();

    assert.deepEqual(summary.reaped, [wt.name]);
    assert.deepEqual(summary.keptReasons, []);
    assert.equal(existsSync(wt.path), false);
    assert.equal(existsSync(wt.admin), false);
    assert.equal(f.git("worktree", "list", "--porcelain").includes(wt.path), false);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("every other lock reason is kept as locked, including empty and near-initializing reasons", () => {
  const f = fixture();
  try {
    const trees = ["maintenance\n", "", "initializing later\n", " initializing\n", "initializing \n"]
      .map((reason, i) => ({ ...f.add(`manual-${i}`, reason), reason }));

    const summary = f.reap();

    assert.deepEqual(summary.reaped, []);
    assert.deepEqual(summary.keptReasons, trees.map(({ name }) => ({ name, reason: "locked" })));
    for (const wt of trees) {
      assert.equal(existsSync(wt.path), true);
      assert.equal(readFileSync(join(wt.admin, "locked"), "utf8"), wt.reason);
    }
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("a dry-run surveys initializing locks and keeps manual locks without removing either", () => {
  const f = fixture();
  try {
    const initializing = f.add("interrupted", "initializing");
    const manual = f.add("manual", "maintenance");

    const summary = f.reap(true);

    assert.deepEqual(summary.reaped, [initializing.name]);
    assert.deepEqual(summary.keptReasons, [{ name: manual.name, reason: "locked" }]);
    for (const wt of [initializing, manual]) {
      assert.equal(existsSync(wt.path), true);
      assert.equal(existsSync(join(wt.admin, "locked")), true);
    }
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("a failed git removal retains stderr and continues to the next worktree", () => {
  const f = fixture();
  try {
    const blocked = f.add("a-invalid-pointer");
    writeFileSync(join(blocked.path, ".git"), `gitdir: ${join(f.repo, ".git", "worktrees", "missing")}\n`);
    const removable = f.add("z-unlocked");
    let stderr: string | undefined;
    assert.throws(() => f.git("worktree", "remove", "--force", blocked.path), (error: unknown) => {
      stderr = (error as { stderr: Buffer }).stderr.toString();
      return /fatal:/.test(stderr);
    });

    const summary = f.reap();

    assert.deepEqual(summary.reaped, [removable.name]);
    assert.equal(existsSync(blocked.path), true);
    const row = summary.keptReasons?.find(({ name }) => name === blocked.name);
    assert.equal(row?.reason, "removal-failed");
    assert.ok(row?.error);
    assert.equal(row.error, stderr);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("an unreadable lock keeps the tree and records the filesystem failure", () => {
  const f = fixture();
  try {
    const wt = f.add("unreadable-lock");
    mkdirSync(join(wt.admin, "locked"));

    const summary = f.reap();

    assert.deepEqual(summary.reaped, []);
    assert.equal(existsSync(wt.path), true);
    const row = summary.keptReasons?.[0];
    assert.equal(row?.reason, "removal-failed");
    assert.ok(row?.error);
    assert.match(row.error, /EISDIR/);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});
